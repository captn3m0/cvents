import { ended, escapeHtml } from "./model.js";

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(s ?? "");
const out = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(out).join("") : v == null || v === false ? "" : escapeHtml(v));
export const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? out(vals[i]) : ""), ""));

const SITE = "Event schedules";
const CSS = `
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b6672;--line:#e3e7ec;--accent:#0b5cad;--chip:#eef3f8}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--muted:#9aa4ae;--line:#2a2f36;--accent:#6cb0ff;--chip:#1e252d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main,header.site,footer{max-width:960px;margin:0 auto;padding:0 16px}
header.site{padding-top:16px;font-size:14px}header.site a{color:var(--muted);text-decoration:none}
a{color:var(--accent)}h1{font-size:1.8rem;line-height:1.2;margin:.6em 0 .2em}h2{margin-top:1.6em}
.muted{color:var(--muted)}.chip{display:inline-block;background:var(--chip);border-radius:4px;padding:0 6px;font-size:13px;margin-right:4px}
nav.tabs{display:flex;gap:16px;border-bottom:1px solid var(--line);margin:16px 0;flex-wrap:wrap}
nav.tabs a{padding:8px 0;text-decoration:none;color:var(--muted)}nav.tabs a.on{color:var(--fg);border-bottom:2px solid var(--accent)}
ol.list{list-style:none;padding:0;margin:0}ol.list>li{border-bottom:1px solid var(--line);padding:10px 0;display:flex;gap:16px}
.when{flex:0 0 120px;color:var(--muted);font-variant-numeric:tabular-nums;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;list-style:none;padding:0}
.card{border:1px solid var(--line);border-radius:8px;padding:12px}.card img,.avatar{width:64px;height:64px;object-fit:cover;border-radius:50%;background:var(--chip)}
.logo{width:96px;height:64px;object-fit:contain;border-radius:4px}.event-logo{float:right;width:96px;height:96px;object-fit:contain;margin:16px 0 8px 16px;border:1px solid var(--line);border-radius:8px;background:#fff}
.prose img{max-width:100%;height:auto}.subscribe{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:8px 0;min-height:56px}footer{margin-top:48px;padding-bottom:32px;font-size:13px;color:var(--muted)}
@media (max-width:600px){ol.list>li{flex-direction:column;gap:2px}.when{flex:none}}
`;

function fmt(iso, zone, opts) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(iso));
  }
}
const dayKey = (iso, zone) => fmt(iso, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = (iso, zone) => fmt(iso, zone, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const time = (iso, zone) => fmt(iso, zone, { hour: "numeric", minute: "2-digit" });
const timeEl = (iso, zone) => html`<time datetime="${iso}">${time(iso, zone)}</time>`;

export function dateRange(start, end, zone = "UTC") {
  const opts = { month: "short", day: "numeric", year: "numeric" };
  if (!start || !end) return fmt(start || end, zone, opts);
  for (const tz of [zone, "UTC"]) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).formatRange(new Date(start), new Date(end));
    } catch {}
  }
  return fmt(start, zone, opts);
}

const withYear = (e) => {
  const y = fmt(e.start, e.zone, { year: "numeric" });
  return !y || e.title.includes(y) ? e.title : `${e.title} ${y}`;
};
const icsHead = (entry, d, origin) => (ended(d.event.end) ? ""
  : `<link rel="alternate" type="text/calendar" title="${escapeHtml(d.event.title)}" href="${escapeHtml(origin)}/e/${entry.slug}/calendar.ics">`);

const logoUrl = (entry) => `/logo/${entry.slug}`;
const ogUrl = (origin, entry) => `${origin}/og/${entry ? entry.slug : "default"}.png`;
const place = (e) => [e.venue, e.city, e.state, e.country].filter(Boolean).join(", ");
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, c) => {
  if (c[0] !== "#") return ENT[c.toLowerCase()] ?? " ";
  const n = c[1] === "x" || c[1] === "X" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
  return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
});
export const textOf = (h) => decode(String(h ?? "").replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "))
  .replace(/[ \t]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
const oneLine = (h) => textOf(h).replace(/\s+/g, " ");
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const meta = (k, v, attr = "property") => (v ? `<meta ${attr}="${k}" content="${escapeHtml(v)}">` : "");

function breadcrumbs(crumbs, name, canonical) {
  if (!crumbs.length || !canonical) return null;
  const origin = new URL(canonical).origin;
  const items = [[`${origin}/`, SITE], ...crumbs.map(([h, l]) => [`${origin}${h}`, l]), [canonical, name]];
  return { "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: items.map(([item, n], i) => ({ "@type": "ListItem", position: i + 1, name: n, item })) };
}

const plural = (n, w) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : "");

export function layout({ title, name, description, canonical, body, jsonld, image, crumbs = [], type = "website", noindex = false, head = "" }) {
  const desc = description ? clip(description) : "";
  const blocks = [jsonld, breadcrumbs(crumbs, name ?? title, canonical)].flat().filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${meta("description", desc, "name")}${noindex ? meta("robots", "noindex", "name") : ""}
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
${meta("og:site_name", SITE)}${meta("og:type", type)}${meta("og:title", name ?? title)}${meta("og:description", desc)}
${meta("og:url", canonical)}${meta("og:image", image)}${image ? `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">${meta("og:image:alt", name ?? title)}` : ""}${meta("twitter:card", image ? "summary_large_image" : "summary", "name")}
${blocks.map(ld).join("\n")}${head}
<style>${CSS}</style></head><body>
<header class="site">${out(html`<a href="/">${SITE}</a>${crumbs.map(([href, label]) => html` / <a href="${href}">${label}</a>`)}`)}</header>
<main>${out(body)}</main>
<footer>Unofficial mirror of public event schedules published through the Cvent Events app. Times are shown in each event's local time zone.
<a href="/api/">API documentation</a> · <a href="https://github.com/captn3m0/cvents">Source</a></footer>
</body></html>`;
}

function eventList(events) {
  const months = new Map();
  for (const e of events) {
    const m = fmt(e.start, "UTC", { month: "long", year: "numeric" });
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(e);
  }
  return html`${[...months].map(([m, list]) => html`<h2>${m}</h2><ol class="list">${list.map((e) => html`
<li><span class="when">${dateRange(e.start, e.end)}</span><span><a href="/e/${e.slug}/">${e.title || e.slug}</a><br>
<span class="muted">${[e.location, e.city, e.country].filter(Boolean).join(", ")}</span></span></li>`)}</ol>`)}`;
}

export function indexPage(events, { origin, past }) {
  const title = past ? `Past events · ${SITE}` : `${SITE}: agendas, speakers and exhibitors`;
  return layout({
    title, canonical: `${origin}${past ? "/past/" : "/"}`, image: ogUrl(origin),
    head: past ? "" : '<meta name="google-site-verification" content="dpX2x5AsdnOqPxHemSPMifMV1Tf3jnnJGJzhbjkLqqg">',
    description: `Agendas, speakers and exhibitors for ${events.length} ${past ? "past" : "upcoming"} conferences and events, readable without installing an app.`,
    body: html`<h1>${past ? "Past events" : "Upcoming events"}</h1>
<p class="muted">${events.length} events. ${past ? html`<a href="/">Upcoming events</a>` : html`<a href="/past/">Past events</a>`}</p>
${eventList(past ? [...events].reverse() : events)}`,
  });
}

const ATCB_SRC = "https://cdn.jsdelivr.net/npm/add-to-calendar-button@3.5.1/dist/atcb.min.js";
const ATCB_SRI = "sha384-lmnBnxg9b0+6VcWEE9T+Nj5rTh4K7s838FrfSQKT20CvpuXOHIqPbaYfcnejDWP6";
// Load the button script once the page is idle so it stays off the critical path.
export const ATCB = `<script>addEventListener("load",()=>(self.requestIdleCallback||setTimeout)(()=>{const s=document.createElement("script");s.src="${ATCB_SRC}";s.integrity="${ATCB_SRI}";s.crossOrigin="anonymous";document.head.append(s)}))</script>`;

function subscribe(entry, d, origin) {
  if (ended(d.event.end)) return "";
  const ics = `${origin}/e/${entry.slug}/calendar.ics`;
  return html`<div class="subscribe"><add-to-calendar-button name="${d.event.title}" subscribe="true" icsFile="${ics}"
 options="'Apple','Google','iCal','Outlook.com','Microsoft365'" label="Subscribe to the agenda" lightMode="system"></add-to-calendar-button>
<a class="muted" href="/e/${entry.slug}/calendar.ics">calendar.ics</a></div>`;
}

function eventHeader(entry, d, tab, origin) {
  const e = d.event;
  const base = `/e/${entry.slug}/`;
  const tabs = [["", "Agenda", true], ["speakers/", `Speakers (${d.speakers.length})`, d.speakers.length],
    ["exhibitors/", `Exhibitors (${d.exhibitors.length})`, d.exhibitors.length]];
  return html`<h1>${e.title}</h1>
<p class="muted">${dateRange(e.start, e.end, e.zone)} · ${e.zone}${e.format ? ` · ${e.format}` : ""}<br>${place(e)}</p>
${ended(e.end) ? html`<p class="chip">This event has ended. The schedule is kept for reference.</p>` : subscribe(entry, d, origin)}
<nav class="tabs">${tabs.filter((t) => t[2]).map(([p, label]) => html`<a href="${base}${p}" class="${tab === p ? "on" : ""}">${label}</a>`)}</nav>`;
}

function eventJsonLd(entry, d, origin) {
  const e = d.event;
  const mode = /hybrid/i.test(e.format) ? "Mixed" : /virtual/i.test(e.format) ? "Online" : "Offline";
  const url = `${origin}/e/${entry.slug}/`;
  return {
    "@context": "https://schema.org", "@type": "Event", "@id": `${url}#event`, name: e.title, url,
    mainEntityOfPage: url, startDate: e.start, endDate: e.end,
    description: clip(oneLine(e.descriptionHtml), 500) || undefined,
    image: [ogUrl(origin, entry), e.image].filter(Boolean),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: `https://schema.org/${mode}EventAttendanceMode`,
    location: eventLocation(entry, d, origin),
    performer: d.speakers.slice(0, 20).map((s) => ({ "@type": "Person", name: s.name, url: `${url}speakers/${s.id}` })),
    subEvent: d.sessions.slice(0, 10).map((s) => ({ "@type": "Event", name: s.name, startDate: s.start, endDate: s.end || undefined,
      url: `${url}sessions/${s.id}` })),
  };
}

function eventLocation(entry, d, origin) {
  const e = d.event;
  const online = { "@type": "VirtualLocation", url: `${origin}/e/${entry.slug}/` };
  const physical = e.venue || e.city ? {
    "@type": "Place", name: e.venue || e.city,
    address: { "@type": "PostalAddress", streetAddress: e.address.join(", ") || undefined, addressLocality: e.city || undefined,
      addressRegion: e.state || undefined, postalCode: e.postalCode || undefined, addressCountry: e.country || undefined },
  } : null;
  if (/virtual/i.test(e.format)) return online;
  if (/hybrid/i.test(e.format)) return physical ? [physical, online] : online;
  return physical || undefined;
}

const speakerNames = (d, ids) => {
  const by = new Map(d.speakers.map((s) => [s.id, s]));
  return ids.map((id) => by.get(id)).filter(Boolean);
};

function sessionRows(entry, d, sessions) {
  const zone = d.event.zone;
  const days = new Map();
  for (const s of sessions) {
    const k = dayKey(s.start, zone);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(s);
  }
  return html`${[...days.values()].map((list) => html`<h2>${dayLabel(list[0].start, zone)}</h2><ol class="list">${list.map((s) => html`
<li><span class="when">${timeEl(s.start, zone)}${s.end ? html` – ${timeEl(s.end, zone)}` : ""}</span><span>
<a href="/e/${entry.slug}/sessions/${s.id}">${s.name}</a>${s.featured ? html` <span class="chip">Featured</span>` : ""}<br>
<span class="muted">${[s.room, s.category].filter(Boolean).join(" · ")}${s.speakers.length ? html`${s.room || s.category ? " · " : ""}${speakerNames(d, s.speakers).map((p) => p.name).join(", ")}` : ""}</span></span></li>`)}</ol>`)}`;
}

export function eventPage(entry, d, { origin }) {
  const e = d.event;
  return layout({
    title: `${withYear(e)} Agenda & Schedule${e.city ? ` · ${e.city}` : ""}`,
    name: e.title, canonical: `${origin}/e/${entry.slug}/`, image: ogUrl(origin, entry), type: "event",
    description: [`${dateRange(e.start, e.end, e.zone)}, ${place(e)}.`,
      [plural(d.sessions.length, "session"), plural(d.speakers.length, "speaker"), plural(d.exhibitors.length, "exhibitor")].filter(Boolean).join(", "),
      oneLine(e.descriptionHtml)].filter(Boolean).join(" "),
    noindex: !d.sessions.length && !d.speakers.length && !d.exhibitors.length,
    head: ATCB + icsHead(entry, d, origin),
    jsonld: eventJsonLd(entry, d, origin),
    body: html`${e.image ? html`<img class="event-logo" src="${logoUrl(entry)}" alt="${e.title} logo" width="96" height="96" fetchpriority="high" decoding="async">` : ""}${eventHeader(entry, d, "", origin)}
${e.descriptionHtml ? html`<div class="prose">${raw(e.descriptionHtml)}</div>` : ""}
${d.sessions.length ? sessionRows(entry, d, d.sessions) : html`<p class="muted">No sessions have been published yet.</p>`}`,
  });
}

export function sessionPage(entry, d, s, { origin }) {
  const e = d.event;
  const people = speakerNames(d, s.speakers);
  return layout({
    title: `${s.name} · ${withYear(e)} Session`, name: s.name, canonical: `${origin}/e/${entry.slug}/sessions/${s.id}`,
    description: `${dayLabel(s.start, e.zone)}, ${time(s.start, e.zone)}${s.room ? `, ${s.room}` : ""} at ${e.title}. ${people.map((p) => p.name).join(", ")}${people.length ? ". " : ""}${oneLine(s.descriptionHtml)}`,
    crumbs: [[`/e/${entry.slug}/`, e.title]], image: ogUrl(origin, entry), type: "event",
    jsonld: { "@context": "https://schema.org", "@type": "Event", name: s.name, url: `${origin}/e/${entry.slug}/sessions/${s.id}`,
      startDate: s.start, endDate: s.end || undefined, eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: `https://schema.org/${/hybrid/i.test(e.format) ? "Mixed" : /virtual/i.test(e.format) ? "Online" : "Offline"}EventAttendanceMode`,
      description: clip(oneLine(s.descriptionHtml), 500) || undefined, image: [ogUrl(origin, entry), e.image].filter(Boolean),
      location: eventLocation(entry, d, origin), performer: people.map((p) => ({ "@type": "Person", name: p.name, url: `${origin}/e/${entry.slug}/speakers/${p.id}` })),
      superEvent: { "@type": "Event", "@id": `${origin}/e/${entry.slug}/#event`, name: e.title, url: `${origin}/e/${entry.slug}/` } },
    body: html`<h1>${s.name}</h1>
<p class="muted">${dayLabel(s.start, e.zone)}, ${timeEl(s.start, e.zone)}${s.end ? html` – ${timeEl(s.end, e.zone)}` : ""} (${e.zone})<br>
${[s.room, s.category].filter(Boolean).join(" · ")}</p>
${s.descriptionHtml ? html`<div class="prose">${raw(s.descriptionHtml)}</div>` : ""}
${people.length ? html`<h2>Speakers</h2>${speakerGrid(entry, people)}` : ""}`,
  });
}

function speakerGrid(entry, people) {
  return html`<ul class="grid">${people.map((p) => html`<li class="card">
${p.image ? html`<img src="${p.image}" alt="${p.name}" width="64" height="64" loading="lazy" decoding="async">` : html`<span class="avatar" style="display:block"></span>`}
<div><a href="/e/${entry.slug}/speakers/${p.id}">${p.name}</a></div>
<div class="muted">${[p.title || p.designation, p.company].filter(Boolean).join(", ")}</div></li>`)}</ul>`;
}

export function speakersPage(entry, d, { origin }) {
  return layout({
    title: `${withYear(d.event)} Speakers`, name: "Speakers", canonical: `${origin}/e/${entry.slug}/speakers/`, image: ogUrl(origin, entry),
    description: `${d.speakers.length} speakers at ${d.event.title}: ${d.speakers.slice(0, 12).map((p) => p.name).join(", ")}.`,
    head: ATCB + icsHead(entry, d, origin),
    crumbs: [[`/e/${entry.slug}/`, d.event.title]],
    body: html`${eventHeader(entry, d, "speakers/", origin)}${speakerGrid(entry, d.speakers)}`,
  });
}

export function speakerPage(entry, d, p, { origin }) {
  const sessions = d.sessions.filter((s) => s.speakers.includes(p.id));
  const links = Object.entries(p.links).filter(([, v]) => v);
  return layout({
    title: `${p.name} · Speaker at ${withYear(d.event)}`, name: p.name, canonical: `${origin}/e/${entry.slug}/speakers/${p.id}`,
    image: ogUrl(origin, entry), type: "profile",
    description: `${[p.title || p.designation, p.company].filter(Boolean).join(", ") || "Speaker"} at ${d.event.title}. ${oneLine(p.bioHtml)}`,
    crumbs: [[`/e/${entry.slug}/`, d.event.title], [`/e/${entry.slug}/speakers/`, "Speakers"]],
    jsonld: { "@context": "https://schema.org", "@type": "Person", name: p.name, url: `${origin}/e/${entry.slug}/speakers/${p.id}`,
      jobTitle: p.title || p.designation || undefined, description: clip(oneLine(p.bioHtml), 300) || undefined,
      worksFor: p.company ? { "@type": "Organization", name: p.company } : undefined, image: p.image || undefined,
      sameAs: links.length ? links.map(([, v]) => v) : undefined,
      performerIn: [{ "@type": "Event", "@id": `${origin}/e/${entry.slug}/#event`, name: d.event.title, url: `${origin}/e/${entry.slug}/` },
        ...sessions.slice(0, 20).map((s) => ({ "@type": "Event", name: s.name, startDate: s.start, url: `${origin}/e/${entry.slug}/sessions/${s.id}` }))] },
    body: html`${p.image ? html`<img class="avatar" src="${p.image}" alt="${p.name}" width="64" height="64" decoding="async">` : ""}
<h1>${[p.prefix, p.name].filter(Boolean).join(" ")}</h1>
<p class="muted">${[p.title || p.designation, p.company].filter(Boolean).join(", ")}</p>
${links.length ? html`<p>${links.map(([k, v]) => html`<a href="${v}" rel="nofollow noopener">${k}</a> `)}</p>` : ""}
${p.bioHtml ? html`<div class="prose">${raw(p.bioHtml)}</div>` : ""}
${sessions.length ? html`<h2>Sessions</h2>${sessionRows(entry, d, sessions)}` : ""}`,
  });
}

export function exhibitorsPage(entry, d, { origin }) {
  const groups = [...d.levels.map((l) => [l.name, d.exhibitors.filter((x) => x.level === l.id)]),
    ["Exhibitors", d.exhibitors.filter((x) => !d.levels.some((l) => l.id === x.level))]].filter(([, l]) => l.length);
  return layout({
    title: `${withYear(d.event)} Exhibitors & Sponsors`, name: "Exhibitors", canonical: `${origin}/e/${entry.slug}/exhibitors/`, image: ogUrl(origin, entry),
    description: `${d.exhibitors.length} exhibitors and sponsors at ${d.event.title}.`,
    head: ATCB + icsHead(entry, d, origin),
    crumbs: [[`/e/${entry.slug}/`, d.event.title]],
    body: html`${eventHeader(entry, d, "exhibitors/", origin)}${groups.map(([name, list]) => html`<h2>${name}</h2>
<ul class="grid">${list.map((x) => html`<li class="card" id="${x.id}">
${x.image ? html`<img class="logo" src="${x.image}" alt="${x.name} logo" width="96" height="64" loading="lazy" decoding="async">` : ""}
<div><strong>${x.name}</strong>${x.booth ? html` <span class="chip">Booth ${x.booth}</span>` : ""}</div>
${x.website ? html`<div><a href="${x.website}" rel="nofollow noopener">${host(x.website)}</a></div>` : ""}
${x.descriptionHtml ? html`<div class="prose muted">${raw(x.descriptionHtml)}</div>` : ""}</li>`)}</ul>`)}`,
  });
}

export function messagePage(title, message, { origin, entry } = {}) {
  return layout({
    title: `${title} · ${SITE}`,
    canonical: entry ? `${origin}/e/${entry.slug}/` : undefined,
    body: html`<h1>${entry?.title || title}</h1><p>${message}</p><p><a href="/">All events</a></p>`,
  });
}

const xml = (s) => escapeHtml(s);
const MAX_URLS = 50000;

export function sitemapIndex(events, origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${xml(origin)}/sitemaps/events.xml</loc></sitemap>
${events.slice(0, MAX_URLS).map((e) => `<sitemap><loc>${xml(`${origin}/e/${e.slug}/sitemap.xml`)}</loc></sitemap>`).join("\n")}
</sitemapindex>`;
}

export function urlset(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.slice(0, MAX_URLS).map(([loc, lastmod]) => `<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;
}

export function eventUrls(entry, d, origin, lastmod) {
  if (!d.sessions.length && !d.speakers.length && !d.exhibitors.length) return [];
  const base = `${origin}/e/${entry.slug}/`;
  return [[base, lastmod],
    ...(d.speakers.length ? [[`${base}speakers/`, lastmod]] : []),
    ...(d.exhibitors.length ? [[`${base}exhibitors/`, lastmod]] : []),
    ...d.sessions.map((s) => [`${base}sessions/${s.id}`, lastmod]),
    ...d.speakers.map((p) => [`${base}speakers/${p.id}`, lastmod])];
}

const SPEC = "https://raw.githubusercontent.com/captn3m0/cvents/main/openapi.yaml";

export function apiPage(origin) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cvent Events API · ${SITE}</title>
<meta name="description" content="OpenAPI description of the Cvent Events app API: event search, anonymous sync sessions and Sync Gateway documents.">
<link rel="canonical" href="${escapeHtml(origin)}/api/">
<style>body{margin:0}.top{font:14px system-ui,sans-serif;padding:8px 16px;border-bottom:1px solid #e3e7ec}</style></head><body>
<div class="top"><a href="/">${SITE}</a> / API · <a href="${SPEC}">openapi.yaml</a></div>
<redoc spec-url="${SPEC}" disable-telemetry="true"></redoc>
<script type="module" src="https://cdn.jsdelivr.net/npm/redoc@3.1.0/bundles/redoc.standalone.js"
 integrity="sha384-JeMYOUn7XELj12XQpz8IRcyCi5pih2IAwvXmTcH3IAFVWrAXJVRNa64PuS3MIj9/" crossorigin="anonymous"></script>
</body></html>`;
}
