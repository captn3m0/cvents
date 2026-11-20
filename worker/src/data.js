import { ENVS, normalise } from "./model.js";
import { sanitizeModel } from "./sanitize.js";

const UA = "cvent/1.0 CventEvents/2.9.0-3612840 (iPhone15,2; ios 18.1)";
const FRESH_MS = 15 * 60 * 1000;
const GONE_MS = 6 * 60 * 60 * 1000;
const KEEP_S = 7 * 24 * 3600;
const SESSION_S = 23 * 3600;
const PAGE = 1000;
const MEM_MAX = 64;

const mem = new Map();
const inflight = new Map();

class Gone extends Error {}

const cacheKey = (kind, id) => new Request(`https://cache.internal/v1/${kind}/${id}`);

async function cacheGet(kind, id) {
  const hit = await caches.default.match(cacheKey(kind, id));
  return hit ? hit.json() : null;
}

function cachePut(kind, id, value, ttl) {
  const body = JSON.stringify(value);
  return caches.default.put(cacheKey(kind, id), new Response(body, {
    headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
  }));
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
  await cachePut("event", entry.id, value, KEEP_S);
  return value;
}

function refreshOnce(entry) {
  if (!inflight.has(entry.id)) {
    inflight.set(entry.id, refresh(entry).finally(() => inflight.delete(entry.id)));
  }
  return inflight.get(entry.id);
}

const isFresh = (v) => Date.now() - v.at < (v.status === "gone" ? GONE_MS : FRESH_MS);

// Serve fresh data, else stale data while refreshing in the background, else wait for upstream.
export async function loadEvent(entry, ctx) {
  let hit = mem.get(entry.id);
  if (!hit) {
    hit = await cacheGet("event", entry.id);
    if (hit) remember(entry.id, hit);
  }
  if (hit && isFresh(hit)) return hit;
  if (!hit) return refreshOnce(entry);
  ctx.waitUntil(refreshOnce(entry).catch((e) => console.error("refresh", entry.id, e.message)));
  return hit;
}
