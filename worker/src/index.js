import EVENTS from "./events.gen.json";
import { lastPutError, loadEvent } from "./data.js";
import * as R from "./render.js";

const BY_SLUG = new Map(EVENTS.map((e) => [e.slug, e]));
const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));

const send = (body, status = 200, type = "text/html; charset=utf-8", maxAge = 300) =>
  new Response(body, { status, headers: { "content-type": type, "cache-control": `public, max-age=${maxAge}` } });
const redirect = (to) => new Response(null, { status: 301, headers: { location: to } });

function split(now) {
  const t = now.toISOString();
  return [EVENTS.filter((e) => (e.end || e.start || "") >= t), EVENTS.filter((e) => (e.end || e.start || "") < t)];
}

async function eventRoute(entry, rest, ctx, origin) {
  const loaded = await loadEvent(entry, ctx, origin);
  const res = await eventResponse(entry, rest, loaded, origin);
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
  if (rest[0] === "sitemap.xml" && rest.length === 1) {
    const lastmod = new Date(loaded.at).toISOString().slice(0, 10);
    return send(R.urlset(R.eventUrls(entry, d, origin, lastmod)), 200, "application/xml; charset=utf-8", 3600);
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

async function route(url, ctx) {
  const origin = url.origin;
  const path = url.pathname;
  if (path === "/" || path === "/past/") {
    const [upcoming, past] = split(new Date());
    return send(R.indexPage(path === "/" ? upcoming : past, { origin, past: path !== "/" }));
  }
  if (path === "/past") return redirect("/past/");
  if (path === "/robots.txt") return send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, 200, "text/plain", 86400);
  if (path === "/sitemap.xml") return send(R.sitemapIndex(EVENTS, origin), 200, "application/xml; charset=utf-8", 3600);
  if (path === "/sitemaps/events.xml") {
    const urls = [[`${origin}/`], [`${origin}/past/`], ...EVENTS.map((e) => [`${origin}/e/${e.slug}/`])];
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
    return eventRoute(entry, rest, ctx, origin);
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
      const res = await route(url, ctx);
      return res ?? send(R.messagePage("Not found", "No such page.", { origin: url.origin }), 404);
    } catch (e) {
      console.error("render", url.pathname, e.stack || e.message);
      return send(R.messagePage("Temporarily unavailable", "The schedule could not be loaded. Try again in a minute.",
        { origin: url.origin }), 503, undefined, 0);
    }
  },
};
