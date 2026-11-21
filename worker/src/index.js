import EVENTS from "./events.gen.json";
import { lastPutError, loadEvent } from "./data.js";
import { calendar } from "./ics.js";
import { ended } from "./model.js";
import { llmsTxt } from "./llms.js";
import { renderOg } from "./og.js";
import * as R from "./render.js";

const BY_SLUG = new Map(EVENTS.map((e) => [e.slug, e]));
const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

const send = (body, status = 200, type = "text/html; charset=utf-8", maxAge = 300) =>
  new Response(body, { status, headers: { "content-type": type, "cache-control": `public, max-age=${maxAge}` } });
const icsGone = () => send("This event has ended; its calendar feed is no longer served.\n", 410, "text/plain; charset=utf-8", 86400);
const redirect = (to) => new Response(null, { status: 301, headers: { location: to } });

function split(now) {
  const t = now.toISOString();
  return [EVENTS.filter((e) => (e.end || e.start || "") >= t), EVENTS.filter((e) => (e.end || e.start || "") < t)];
}

// Validators come from the content hash, so unchanged data answers 304 even after a refresh.
function conditional(req, res, entry, loaded) {
  if (res.status !== 200 || !loaded.hash) return res;
  const when = new Date(loaded.changed ?? loaded.at).toUTCString();
  const etag = `W/"${loaded.hash}${ended(entry.end) ? "e" : ""}"`;
  const headers = new Headers(res.headers);
  headers.set("etag", etag);
  headers.set("last-modified", when);
  const inm = req.headers.get("if-none-match");
  const ims = Date.parse(req.headers.get("if-modified-since") ?? "");
  const same = inm ? inm.split(",").some((t) => t.trim() === etag) : ims >= Math.floor(Date.parse(when) / 1000) * 1000;
  if (same) {
    headers.delete("content-type");
    return new Response(null, { status: 304, headers });
  }
  return new Response(res.body, { status: 200, headers });
}

async function eventRoute(entry, rest, ctx, origin, env, req) {
  if (rest.join("/") === "calendar.ics" && ended(entry.end)) return icsGone();
  const loaded = await loadEvent(entry, ctx, origin, env.CACHE);
  const res = conditional(req, await eventResponse(entry, rest, loaded, origin), entry, loaded);
  res.headers.set("x-data-age", String(Math.round((Date.now() - loaded.at) / 1000)));
  res.headers.set("x-cache", loaded.source);
  if (lastPutError) res.headers.set("x-cache-error", lastPutError);
  return res;
}

async function eventResponse(entry, rest, loaded, origin) {
  if (loaded.status === "gone") {
    return send(R.messagePage("Event unavailable", "This event is no longer publicly available.", { origin, entry }), 410);
  }
  const d = loaded.data;
  const opts = { origin };
  const notFound = () => send(R.messagePage("Not found", "That page does not exist for this event.", opts), 404);
  if (rest.length === 0) return send(R.eventPage(entry, d, opts));
  if (rest[0] === "calendar.ics" && rest.length === 1) {
    if (ended(d.event.end)) return icsGone();
    return send(calendar(entry, d, origin, loaded.at), 200, "text/calendar; charset=utf-8", 3600);
  }
  if (rest[0] === "sitemap.xml" && rest.length === 1) {
    return send(R.urlset(R.eventUrls(entry, d, origin, new Date(loaded.changed ?? loaded.at).toISOString())), 200, "application/xml; charset=utf-8", 3600);
  }
  const [kind, id] = rest;
  if (kind === "speakers" && rest.length === 1) return d.speakers.length ? send(R.speakersPage(entry, d, opts)) : notFound();
  if (kind === "exhibitors" && rest.length === 1) return d.exhibitors.length ? send(R.exhibitorsPage(entry, d, opts)) : notFound();
  if (kind === "sessions" && rest.length === 2) {
    const s = d.sessions.find((x) => x.id === id);
    return s ? send(R.sessionPage(entry, d, s, opts)) : notFound();
  }
  if (kind === "speakers" && rest.length === 2) {
    const p = d.speakers.find((x) => x.id === id);
    return p ? send(R.speakerPage(entry, d, p, opts)) : notFound();
  }
  return notFound();
}

// Speaker photos come from live data, so cache for six hours; a degraded render is kept for five minutes.
async function ogImage(url, entry, ctx, env) {
  const key = new Request(url.origin + url.pathname);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  let speakers = null;
  if (entry) {
    try {
      const loaded = await loadEvent(entry, ctx, url.origin, env.CACHE);
      const list = loaded.status === "ok" ? loaded.data.speakers : [];
      const photos = [...list.filter((p) => p.image)].sort((x, y) => y.featured - x.featured).slice(0, 4).map((p) => p.image);
      speakers = { count: list.length, photos };
    } catch (e) {
      console.error("og data", entry.id, e.message);
    }
  }
  const res = send(await renderOg(entry, url.origin, speakers), 200, "image/png", entry && !speakers ? 300 : 21600);
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

// Event logos are served from our own domain, resized by Cloudflare Images when enabled, with a month-long cache.
async function logoImage(url, entry, ctx) {
  if (!entry.image) return null;
  const key = new Request(url.origin + url.pathname);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const up = await fetch(entry.image, { cf: { image: { width: 192, height: 192, fit: "contain", format: "webp" } } });
  const type = up.headers.get("content-type") || "";
  if (!up.ok || !type.startsWith("image/")) return null;
  const res = new Response(up.body, { headers: { "content-type": type, "cache-control": "public, max-age=2592000, immutable" } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

async function route(url, ctx, env, req) {
  const origin = url.origin;
  const path = url.pathname;
  if (path === "/" || path === "/past/") {
    const [upcoming, past] = split(new Date());
    return send(R.indexPage(path === "/" ? upcoming : past, { origin, past: path !== "/" }));
  }
  if (path === "/past") return redirect("/past/");
  if (path === "/api/") return send(R.apiPage(origin), 200, undefined, 3600);
  if (path === "/api") return redirect("/api/");
  const og = path.match(/^\/og\/([a-z0-9-]+)\.png$/);
  if (og && (og[1] === "default" || BY_SLUG.has(og[1]))) return ogImage(url, og[1] === "default" ? null : BY_SLUG.get(og[1]), ctx, env);
  if (env.INDEXNOW_KEY && path === `/${env.INDEXNOW_KEY}.txt`) return send(`${env.INDEXNOW_KEY}\n`, 200, "text/plain; charset=utf-8", 86400);
  const logo = path.match(/^\/logo\/([a-z0-9-]+)$/);
  if (logo && BY_SLUG.has(logo[1])) return logoImage(url, BY_SLUG.get(logo[1]), ctx);
  if (path === "/llms.txt") return send(llmsTxt(origin), 200, "text/plain; charset=utf-8", 86400);
  if (path === "/robots.txt") return send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, 200, "text/plain", 86400);
  if (path === "/sitemap.xml") return send(R.sitemapIndex(EVENTS, origin), 200, "application/xml; charset=utf-8", 3600);
  if (path === "/sitemaps/events.xml") {
    const urls = [[`${origin}/`], [`${origin}/past/`], [`${origin}/api/`]];
    return send(R.urlset(urls), 200, "application/xml; charset=utf-8", 3600);
  }
  const m = path.match(/^\/e\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    const entry = BY_SLUG.get(m[1]);
    if (!entry) {
      const byId = BY_ID.get(m[1]);
      return byId ? redirect(`/e/${byId.slug}${m[2] || "/"}`) : null;
    }
    if (!m[2]) return redirect(`/e/${entry.slug}/`);
    const rest = m[2].split("/").filter(Boolean);
    if (m[2].endsWith("/") && rest.length === 2) return redirect(`/e/${entry.slug}/${rest.join("/")}`);
    return eventRoute(entry, rest, ctx, origin, env, req);
  }
  return null;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const url = new URL(req.url);
    try {
      const res = await route(url, ctx, env, req);
      return res ?? send(R.messagePage("Not found", "No such page.", { origin: url.origin }), 404);
    } catch (e) {
      console.error("render", url.pathname, e.stack || e.message);
      return send(R.messagePage("Temporarily unavailable", "The schedule could not be loaded. Try again in a minute.",
        { origin: url.origin }), 503, undefined, 0);
    }
  },
};
