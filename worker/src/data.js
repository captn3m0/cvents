import { ENVS, ended, normalise } from "./model.js";
import { sanitizeModel } from "./sanitize.js";

const UA = "cvent/1.0 CventEvents/2.9.0-3612840 (iPhone15,2; ios 18.1)";
const HOUR = 3600 * 1000;
const SOON_MS = 3 * 24 * HOUR;
const GONE_MS = 6 * 60 * 60 * 1000;
const KEEP_S = 7 * 24 * 3600;
const SESSION_S = 23 * 3600;
const PAGE = 1000;
const MEM_MAX = 64;

const mem = new Map();
const inflight = new Map();

class Gone extends Error {}

let origin = "https://cvents.bb8.fun";
let kv = null;
const cacheKey = (kind, id) => new Request(`${origin}/__cache/v1/${kind}/${id}`);

async function cacheGet(kind, id) {
  const hit = await caches.default.match(cacheKey(kind, id));
  return hit ? hit.json() : null;
}

export let lastPutError = "";

async function kvGet(id) {
  try {
    return kv ? await kv.get(`event:${id}`, "json") : null;
  } catch (e) {
    console.error("kv get", e.message);
    return null;
  }
}

async function kvPut(id, value) {
  try {
    if (kv) await kv.put(`event:${id}`, JSON.stringify(value), { expirationTtl: KEEP_S });
  } catch (e) {
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
  } catch (e) {
    lastPutError = `${kind}: ${e.message}`.slice(0, 200);
    console.error("cache put", lastPutError);
  }
}

function remember(id, value) {
  mem.delete(id);
  mem.set(id, value);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

async function call(url, { body, cookie } = {}) {
  const headers = { "user-agent": UA, accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) });
  if (res.ok) return res.json();
  const err = new Error(`${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
  err.status = res.status;
  throw err;
}

async function syncCookie(entry, fresh) {
  const cached = !fresh && (await cacheGet("session", entry.id));
  if (cached) return cached.cookie;
  const [falcon] = ENVS[entry.env];
  const q = new URLSearchParams({ environment: entry.env, preview: "false", livePreview: "false" });
  let s;
  try {
    s = await call(`${falcon}/events/${entry.id}/sync/anonymous?${q}`, {
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
      const res = await call(`${sg}/_changes?${q}`, { cookie });
      for (const row of res.results ?? []) {
        if (row.deleted || row.doc?._deleted) docs.delete(row.id);
        else if (row.doc?.type) docs.set(row.doc._id, row.doc);
      }
      if ((res.results ?? []).length < PAGE) return [...docs.values()];
      since = res.last_seq;
    }
  } catch (e) {
    if (retry && e.status === 401) return fetchDocs(entry, false);
    throw e;
  }
}

async function refresh(entry) {
  let value;
  try {
    const docs = await fetchDocs(entry);
    value = { at: Date.now(), status: "ok", data: await sanitizeModel(normalise(entry, docs)) };
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
    value = { at: Date.now(), status: "gone" };
  }
  remember(entry.id, value);
  await Promise.all([cachePut("event", entry.id, value, KEEP_S), kvPut(entry.id, value)]);
  return value;
}

function refreshOnce(entry) {
  if (!inflight.has(entry.id)) {
    inflight.set(entry.id, refresh(entry).finally(() => inflight.delete(entry.id)));
  }
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

// Look in memory, then the colo cache, then KV; serve stale data while refreshing in the background.
export async function loadEvent(entry, ctx, site, store) {
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
  if (!hit) return { ...(await refreshOnce(entry)), source: "miss" };
  ctx.waitUntil(refreshOnce(entry).catch((e) => console.error("refresh", entry.id, e.message)));
  return { ...hit, source: `${source}-stale` };
}
