import { textOf } from "./render.js";

const enc = new TextEncoder();
const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// RFC 5545 folds content lines at 75 octets; continuation lines start with a space.
export function fold(line) {
  const parts = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

function vevent({ uid, start, end, summary, location, description, url, category, now }) {
  return [
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`,
    ...(end && end > start ? [`DTEND:${stamp(end)}`] : []),
    `SUMMARY:${esc(summary)}`,
    ...(location ? [`LOCATION:${esc(location)}`] : []),
    ...(description ? [`DESCRIPTION:${esc(description)}`] : []),
    ...(category ? [`CATEGORIES:${esc(category)}`] : []),
    `URL:${url}`, "END:VEVENT",
  ];
}

export function calendar(entry, d, origin, fetchedAt) {
  const e = d.event;
  const host = new URL(origin).host;
  const now = new Date(fetchedAt).toISOString();
  const base = `${origin}/e/${entry.slug}/`;
  const venue = [e.venue, e.city].filter(Boolean).join(", ");
  const names = new Map(d.speakers.map((p) => [p.id, p.name]));
  const events = d.sessions.length
    ? d.sessions.map((s) => {
      const url = `${base}sessions/${s.id}`;
      const who = s.speakers.map((id) => names.get(id)).filter(Boolean).join(", ");
      return vevent({
        uid: `${s.id}@${host}`, start: s.start, end: s.end, summary: s.name, now, url, category: s.category,
        location: [s.room, venue].filter(Boolean).join(", "),
        description: [who && `Speakers: ${who}`, textOf(s.descriptionHtml), url].filter(Boolean).join("\n\n"),
      });
    })
    : [vevent({ uid: `${e.id}@${host}`, start: e.start, end: e.end, summary: e.title, now, url: base,
      location: venue, description: [textOf(e.descriptionHtml), base].filter(Boolean).join("\n\n") })];
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${host}//Event schedules//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(e.title)}`, `X-WR-CALDESC:${esc(`Agenda for ${e.title}. ${base}`)}`, `X-WR-TIMEZONE:${e.zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
    ...events.flat(), "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
