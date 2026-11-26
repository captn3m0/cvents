import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as M from "../worker/src/metrics.js";
import { globalFamilies } from "../worker/src/stats.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const EVENTS = [
  { id: "a", env: "production", start: "2026-11-21T00:00:00Z", end: "2026-11-22T00:00:00Z", country: "US", image: "https://x/a.png" },
  { id: "b", env: "production", start: "2026-11-19T00:00:00Z", end: "2026-11-21T00:00:00Z", country: "US" },
  { id: "c", env: "production-eu", start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" },
];
const INDEX = {
  at: NOW - 60e3,
  rows: [
    { id: "a", at: NOW - 2 * 3600e3, status: "ok", changed: NOW - 3 * 86400e3, sessions: 4, speakers: 2, exhibitors: 0 },
    { id: "b", at: NOW - 600e3, status: "ok", changed: NOW - 3600e3, sessions: 0, speakers: 0, exhibitors: 0 },
    { id: "zz" },
  ],
};

const value = (text, name, labels = "") => {
  const line = text.split("\n").find((l) => l.startsWith(`${name}${labels} `) || l.startsWith(`${name}{${labels}`));
  return line && Number(line.split(" ").at(-1));
};

function lint(text) {
  assert.ok(text.endsWith("\n"));
  const seen = new Set();
  let current = null;
  for (const line of text.trimEnd().split("\n")) {
    const meta = line.match(/^# (HELP|TYPE) ([a-z_:][a-z0-9_:]*) (.+)$/);
    if (meta) {
      if (meta[1] === "TYPE") {
        assert.ok(!seen.has(meta[2]), `duplicate family ${meta[2]}`);
        assert.match(meta[3], /^(counter|gauge|histogram)$/);
        if (meta[3] === "counter") assert.match(meta[2], /_total$/);
        seen.add(meta[2]);
        current = meta[2];
      }
      continue;
    }
    const m = line.match(/^([a-z_:][a-z0-9_:]*)(\{([a-z_][a-z0-9_]*="(\\.|[^"\\])*",?)*\})? (-?[0-9.e+-]+|\+Inf|-Inf|NaN)$/);
    assert.ok(m, `bad sample line: ${line}`);
    assert.ok(m[1] === current || m[1].replace(/_(bucket|sum|count)$/, "") === current, `${m[1]} outside its family`);
  }
  return seen;
}

test("renders valid exposition text with isolate labels", async () => {
  M.begin({ cf: { colo: "SIN" } });
  M.httpRequests.inc({ route: "home", method: "GET", status: "200" });
  M.httpRequests.inc({ route: "home", method: "GET", status: "200" });
  M.errors.inc({ where: 'we"ird\\label\n' });
  const stop = M.refreshTime.start();
  stop({ result: "ok" });
  M.refreshTime.observe({ result: "ok" }, 120);
  const text = M.exposition(globalFamilies(EVENTS, INDEX, NOW, { id: "v1", tag: "", timestamp: "2026-11-20T00:00:00Z" }));
  const families = lint(text);
  assert.ok(families.has("cvent_http_requests_total") && families.has("cvent_kv_items"));
  assert.match(text, /cvent_http_requests_total\{isolate="[0-9a-f]{8}",colo="SIN",route="home",method="GET",status="200"\} 2/);
  assert.match(text, /where="we\\"ird\\\\label\\n"/);
  const buckets = text.split("\n").filter((l) => l.startsWith("cvent_refresh_duration_seconds_bucket")).map((l) => Number(l.split(" ")[1]));
  assert.deepEqual(buckets, [...buckets].sort((a, b) => a - b));
  assert.match(text, /cvent_refresh_duration_seconds_bucket\{[^}]*le="\+Inf"\} 2/);
  assert.match(text, /cvent_refresh_duration_seconds_bucket\{[^}]*le="60"\} 1/);
  assert.match(text, /^cvent_events\{env="production",phase="upcoming"\} 1$/m);
  assert.doesNotMatch(text, /^cvent_events\{isolate/m);
});

test("computes bundle and KV gauges", () => {
  const text = M.exposition(globalFamilies(EVENTS, INDEX, NOW));
  assert.equal(value(text, "cvent_events", '{env="production",phase="ongoing"}'), 1);
  assert.equal(value(text, "cvent_events", '{env="production-eu",phase="past"}'), 1);
  assert.equal(value(text, "cvent_events_by_country", '{country="unknown"}'), 1);
  assert.equal(value(text, "cvent_events_starting_soon", '{within="1d"}'), 1);
  assert.equal(value(text, "cvent_events_hourly_refresh"), 2);
  assert.equal(value(text, "cvent_events_feed_ended"), 1);
  assert.equal(value(text, "cvent_kv_index_up"), 1);
  assert.equal(value(text, "cvent_kv_events", '{status="ok"}'), 2);
  assert.equal(value(text, "cvent_kv_events_orphaned"), 1);
  assert.equal(value(text, "cvent_events_uncached"), 1);
  assert.equal(value(text, "cvent_kv_events_stale"), 1);
  assert.equal(value(text, "cvent_kv_items", '{kind="sessions"}'), 4);
  assert.equal(value(text, "cvent_kv_events_empty"), 1);
  assert.equal(value(text, "cvent_kv_events_changed", '{within="1d"}'), 1);
  assert.equal(value(text, "cvent_kv_last_change_timestamp_seconds"), (NOW - 3600e3) / 1000);
  assert.equal(value(text, "cvent_build_info"), undefined);
  assert.equal(value(M.exposition(globalFamilies(EVENTS, null, NOW)), "cvent_kv_index_up"), 0);
});

test("authenticated metrics accept any basic or bearer credentials", () => {
  for (const h of ["Basic dTpw", "basic x", "Bearer glc_abc", "BEARER t"]) assert.equal(M.authorized(h), true, h);
  for (const h of [null, undefined, "", "Basic", "Basic ", "Digest x", "Token x", "x Basic y"]) assert.equal(M.authorized(h), false, String(h));
});

test("maps paths to a fixed set of route labels", () => {
  const key = readFileSync("wrangler.jsonc", "utf8").match(/"INDEXNOW_KEY":\s*"([0-9a-f]{32})"/)[1];
  const cases = {
    "/": "home", "/past/": "past", "/api": "api", "/metrics": "metrics", "/metrics/authenticated": "metrics_authenticated",
    "/og/default.png": "og", "/logo/x-1": "logo", [`/${key}.txt`]: "indexnow", "/e/x-1/": "event", "/e/x-1": "event",
    "/e/x-1/calendar.ics": "event_ics", "/e/x-1/speakers": "event_speakers", "/e/x-1/speakers/9": "event_speaker",
    "/e/x-1/sessions/9": "event_session", "/e/x-1/exhibitors": "event_exhibitors", "/e/x-1/nope/1/2": "event_other",
    "/wp-login.php": "other", "/metrics/": "other",
  };
  for (const [path, route] of Object.entries(cases)) assert.equal(M.routeName(path), route, path);
});
