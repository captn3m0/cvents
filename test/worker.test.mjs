import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalise } from "../worker/src/model.js";
import * as R from "../worker/src/render.js";

const load = (f) => (JSON.parse(readFileSync(`re/samples/${f}`, "utf8")).results ?? []).map((r) => r.doc).filter((d) => d?.type);
const samples = [
  [{ id: "da1f6296-bb82-42e1-b812-6babba2314da", env: "production", slug: "demo-da1f6296" }, load("changes.json")],
  [{ id: "ed618c35-3f14-41cd-a2db-5f952f436e78", env: "production", slug: "health-ed618c35" }, load("changes_healthcare.json")],
];

function allPages(entry, d, origin) {
  return [R.eventPage(entry, d, { origin }), R.speakersPage(entry, d, { origin }), R.exhibitorsPage(entry, d, { origin }),
    ...d.sessions.map((s) => R.sessionPage(entry, d, s, { origin })),
    ...d.speakers.map((p) => R.speakerPage(entry, d, p, { origin })),
    R.urlset(R.eventUrls(entry, d, origin, "2026-11-20"))];
}

for (const [entry, docs] of samples) {
  test(`renders ${entry.slug}`, () => {
    const d = normalise(entry, docs);
    assert.ok(d.event.title);
    assert.ok(d.sessions.length > 0);
    assert.ok(d.sessions.every((s, i) => i === 0 || d.sessions[i - 1].start <= s.start));
    const pages = allPages(entry, d, "https://example.org").join("\n");
    const hidden = docs.filter((x) => x.type === "Session" && (x.displayOnAgenda === false || x.restrictSessionVisibility));
    for (const s of hidden) assert.ok(!pages.includes(`/sessions/${s.id}`));
    assert.equal(R.eventUrls(entry, d, "https://example.org").length,
      1 + (d.speakers.length > 0) + (d.exhibitors.length > 0) + d.sessions.length + d.speakers.length);
  });
}

test("escapes interpolated values", () => {
  const out = String(R.html`<p>${"<script>x</script>"}</p>`);
  assert.equal(out, "<p>&#60;script&#62;x&#60;/script&#62;</p>");
});

test("sitemap index lists every event", () => {
  const xml = R.sitemapIndex([{ slug: "a-1" }, { slug: "b&c" }], "https://example.org");
  assert.match(xml, /e\/a-1\/sitemap.xml/);
  assert.match(xml, /b&#38;c/);
});

test("builds a valid ICS feed", async () => {
  const { calendar } = await import("../worker/src/ics.js");
  const [entry, docs] = samples[0];
  const d = normalise(entry, docs);
  const ics = calendar(entry, d, "https://example.org", Date.parse("2026-11-20T00:00:00Z"));
  const lines = ics.split("\r\n");
  assert.equal(lines.at(-1), "");
  assert.ok(lines.every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal((ics.match(/^BEGIN:VEVENT/gm) ?? []).length, d.sessions.length);
  assert.ok(!/\n(?!\s)[^\r]*\n/.test(ics.replace(/\r\n/g, "")), "bare LF in feed");
});

test("treats events as ended a day after they finish", async () => {
  const { ended } = await import("../worker/src/model.js");
  const now = Date.parse("2026-11-20T12:00:00Z");
  assert.equal(ended("2026-11-19T13:00:00Z", now), false);
  assert.equal(ended("2026-11-19T11:00:00Z", now), true);
  assert.equal(ended(undefined, now), false);
});
