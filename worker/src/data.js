import { ENVS, ended, normalise } from "./model.js";
import * as M from "./metrics.js";
import { sanitizeModel } from "./sanitize.js";

const UA = "cvent/1.0 CventEvents/2.9.0-3612840 (iPhone15,2; ios 18.1)";
const HOUR = 3600 * 1000;
const SOON_MS = 3 * 24 * HOUR;
const GONE_MS = 6 * 60 * 60 * 1000;
const KEEP_S = 7 * 24 * 3600;
const SESSION_S = 23 * 3600;
const PAGE = 1000;
const MEM_MAX = 64;
const INDEX_S = 300;

const mem = new Map();
const inflight = new Map();
M.gauge("cvent_mem_events", "Events held in the in-memory LRU.", () => mem.size);
M.gauge("cvent_refreshes_inflight", "Event refreshes currently in flight.", () => inflight.size);

class Gone extends Error {}

let origin = "https://cvents.bb8.fun";
let kv = null;
const cacheKey = (kind, id) => new Request(`${origin}/__cache/v1/${kind}/${id}`);

async function cacheGet(kind, id) {
  const hit = await caches.default.match(cacheKey(kind, id));
  M.cacheOps.inc({ kind, op: "get", result: hit ? "hit" : "miss" });
  return hit ? hit.json() : null;
}

export let lastPutError = "";

async function kvGet(id) {
  try {
    if (!kv) return null;
    const v = await kv.get(`event:${id}`, "json");
    M.kvOps.inc({ op: "get", result: v ? "hit" : "miss" });
    return v;
  } catch (e) {
    M.kvOps.inc({ op: "get", result: "error" });
    console.error("kv get", e.message);
    return null;
  }
}

const kvMeta = (v) => (v.status !== "ok" ? { at: v.at, status: v.status } : {
  at: v.at, status: v.status, changed: v.changed,
  sessions: v.data.sessions.length, speakers: v.data.speakers.length, exhibitors: v.data.exhibitors.length,
});

async function kvPut(id, value) {
  if (!kv) return;
  try {
    await kv.put(`event:${id}`, JSON.stringify(value), { expirationTtl: KEEP_S, metadata: kvMeta(value) });
    M.kvOps.inc({ op: "put", result: "ok" });
  } catch (e) {
    M.kvOps.inc({ op: "put", result: "error" });
    lastPutError = `kv: ${e.message}`.slice(0, 200);
    console.error("kv put", lastPutError);
  }
}

async function cachePut(kind, id, value, ttl) {
  const body = JSON.stringify(value);
  try {
    await caches.default.put(cacheKey(kind, id), new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    }));
    M.cacheOps.inc({ kind, op: "put", result: "ok" });
  } catch (e) {
    M.cacheOps.inc({ kind, op: "put", result: "error" });
    lastPutError = `${kind}: ${e.message}`.slice(0, 200);
    console.error("cache put", lastPutError);
  }
}

function remember(id, value) {
  mem.delete(id);
  mem.set(id, value);
  if (mem.size > MEM_MAX) {
    mem.delete(mem.keys().next().value);
    M.memEvictions.inc();
  }
}

async function call(service, url, { body, cookie } = {}) {
  const headers = { "user-agent": UA, accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (body) headers["content-type"] = "application/json";
  const res = await M.upstreamFetch(service, url, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) });
  if (res.ok) return res.json();
  const err = new Error(`${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
  err.status = res.status;
  throw err;
}

async function syncCookie(entry, fresh) {
  const cached = !fresh && (await cacheGet("session", entry.id));
  M.sessions.inc({ source: cached ? "cache" : "new" });
  if (cached) return cached.cookie;
  const [falcon] = ENVS[entry.env];
  const q = new URLSearchParams({ environment: entry.env, preview: "false", livePreview: "false" });
  let s;
  try {
    s = await call("falcon", `${falcon}/events/${entry.id}/sync/anonymous?${q}`, {
      body: { deviceId: crypto.randomUUID(), accessCode: null },
    });
  } catch (e) {
    if (e.status >= 400 && e.status < 500 && e.status !== 429) throw new Gone(e.message);
    throw e;
  }
  const cookie = `${s.cookie_name}=${s.session_id}`;
  await cachePut("session", entry.id, { cookie }, SESSION_S);
  return cookie;
}

async function fetchDocs(entry, retry = true) {
  const [, sg] = ENVS[entry.env];
  const cookie = await syncCookie(entry, !retry);
  const docs = new Map();
  let since = null;
  try {
    for (;;) {
      const q = new URLSearchParams({
        include_docs: "true", limit: String(PAGE), filter: "sync_gateway/bychannel",
        channels: `production::event::${entry.id}`,
      });
      if (since !== null) q.set("since", since);
      const res = await call("sync_gateway", `${sg}/_changes?${q}`, { cookie });
      M.changesPages.inc();
      for (const row of res.results ?? []) {
        const kind = row.deleted || row.doc?._deleted ? "deleted" : row.doc?.type ? "doc" : "skipped";
        M.changesDocs.inc({ kind });
        if (kind === "deleted") docs.delete(row.id);
        else if (kind === "doc") docs.set(row.doc._id, row.doc);
      }
      if ((res.results ?? []).length < PAGE) return [...docs.values()];
      since = res.last_seq;
    }
  } catch (e) {
    if (retry && e.status === 401) {
      M.sessionRetries.inc();
      return fetchDocs(entry, false);
    }
    throw e;
  }
}

async function digest(data) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(JSON.stringify(data)));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function refresh(entry, prev) {
  let value;
  try {
    const docs = await fetchDocs(entry);
    const data = await sanitizeModel(normalise(entry, docs));
    const hash = await digest(data);
    const at = Date.now();
    M.refreshContent.inc({ change: !prev?.hash ? "new" : prev.hash === hash ? "same" : "changed" });
    value = { at, status: "ok", hash, changed: prev?.hash === hash ? prev.changed ?? prev.at : at, data };
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
    value = { at: Date.now(), status: "gone" };
  }
  remember(entry.id, value);
  await Promise.all([cachePut("event", entry.id, value, KEEP_S), kvPut(entry.id, value)]);
  return value;
}

function refreshOnce(entry, prev) {
  if (inflight.has(entry.id)) {
    M.refreshJoins.inc();
    return inflight.get(entry.id);
  }
  const stop = M.refreshTime.start();
  const done = (result) => {
    M.refreshes.inc({ result });
    stop({ result });
  };
  const job = refresh(entry, prev).then((v) => (done(v.status), v), (e) => {
    done("error");
    throw e;
  });
  inflight.set(entry.id, job.finally(() => inflight.delete(entry.id)));
  return inflight.get(entry.id);
}

// Refresh hourly from three days before an event until it ends, every 6 hours otherwise.
export function freshFor(entry, v, now = Date.now()) {
  if (v.status === "gone") return GONE_MS;
  const start = v.data?.event?.start || entry.start;
  const end = v.data?.event?.end || entry.end;
  const near = !!start && Date.parse(start) - now < SOON_MS && !ended(end, now);
  return near ? HOUR : 6 * HOUR;
}

const isFresh = (entry, v) => Date.now() - v.at < freshFor(entry, v);

export async function loadEvent(entry, ctx, site, store) {
  const stop = M.loadTime.start();
  try {
    const v = await lookup(entry, ctx, site, store);
    M.loads.inc({ source: v.source });
    return v;
  } catch (e) {
    M.loads.inc({ source: "error" });
    throw e;
  } finally {
    stop();
  }
}

// Look in memory, then the colo cache, then KV; serve stale data while refreshing in the background.
async function lookup(entry, ctx, site, store) {
  origin = site;
  kv = store ?? null;
  let hit = mem.get(entry.id);
  let source = "mem";
  if (!hit) {
    hit = await cacheGet("event", entry.id);
    source = "cache";
  }
  if (!hit || !isFresh(entry, hit)) {
    const fromKv = await kvGet(entry.id);
    if (fromKv && (!hit || fromKv.at > hit.at)) {
      hit = fromKv;
      source = "kv";
      ctx.waitUntil(cachePut("event", entry.id, hit, KEEP_S));
    }
  }
  if (hit) remember(entry.id, hit);
  if (hit && isFresh(entry, hit)) return { ...hit, source };
  if (!hit) return { ...(await refreshOnce(entry, await kvGet(entry.id))), source: "miss" };
  ctx.waitUntil(refreshOnce(entry, hit).catch((e) => console.error("refresh", entry.id, e.message)));
  return { ...hit, source: `${source}-stale` };
}

export async function kvIndex(store, site) {
  if (!store) return null;
  origin = site;
  const hit = await cacheGet("metrics", "kv-index");
  if (hit) return hit;
  const rows = [];
  try {
    let cursor;
    do {
      const page = await store.list({ prefix: "event:", cursor });
      for (const k of page.keys) rows.push({ id: k.name.slice(6), ...(k.metadata ?? {}) });
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    M.kvOps.inc({ op: "list", result: "ok" });
  } catch (e) {
    M.kvOps.inc({ op: "list", result: "error" });
    throw e;
  }
  const index = { at: Date.now(), rows };
  await cachePut("metrics", "kv-index", index, INDEX_S);
  return index;
}
