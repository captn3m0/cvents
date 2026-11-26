// Gauges computed at scrape time from the event bundle and the KV index, identical whichever isolate answers.
import { freshFor } from "./data.js";
import { ended } from "./model.js";

const DAY = 86400e3;
const WINDOWS = [["1d", DAY], ["7d", 7 * DAY], ["30d", 30 * DAY]];
const gauge = (name, help, samples) => ({ type: "gauge", name, help, samples });
const count = (items, fn) => items.filter(fn).length;

function tally(items, key) {
  const m = new Map();
  for (const i of items) {
    const k = JSON.stringify(key(i));
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([k, v]) => [JSON.parse(k), v]);
}

function bundle(events, now) {
  const t = new Date(now).toISOString();
  const phase = (e) => ((e.end || e.start || "") < t ? "past" : (e.start || "") > t ? "upcoming" : "ongoing");
  const startsIn = (e, ms) => !!e.start && Date.parse(e.start) > now && Date.parse(e.start) - now <= ms;
  return [
    gauge("cvent_events", "Events in the deployed bundle, by environment and phase.", tally(events, (e) => ({ env: e.env, phase: phase(e) }))),
    gauge("cvent_events_by_country", "Events in the deployed bundle, by country.", tally(events, (e) => ({ country: e.country || "unknown" }))),
    gauge("cvent_events_starting_soon", "Upcoming events starting within a window.",
      WINDOWS.map(([within, ms]) => [{ within }, count(events, (e) => startsIn(e, ms))])),
    gauge("cvent_events_hourly_refresh", "Events inside their hourly refresh window.",
      [[{}, count(events, (e) => freshFor(e, { status: "ok" }, now) <= 3600e3)]]),
    gauge("cvent_events_feed_ended", "Events whose calendar feed now answers 410.", [[{}, count(events, (e) => ended(e.end, now))]]),
    gauge("cvent_events_with_logo", "Events with a logo image.", [[{}, count(events, (e) => !!e.image)]]),
  ];
}

function cached(events, index, now) {
  if (!index) return [gauge("cvent_kv_index_up", "Whether the KV index could be listed.", [[{}, 0]])];
  const byId = new Map(events.map((e) => [e.id, e]));
  const live = index.rows.filter((r) => byId.has(r.id));
  const ok = live.filter((r) => r.status === "ok" && r.sessions !== undefined);
  const ats = live.filter((r) => r.at).map((r) => r.at);
  const changes = ok.filter((r) => r.changed).map((r) => r.changed);
  const stale = (r) => r.at && now - r.at > freshFor(byId.get(r.id), { status: r.status }, now);
  const sum = (k) => ok.reduce((n, r) => n + (r[k] ?? 0), 0);
  const ts = (v) => (v === -Infinity || v === Infinity ? [] : [[{}, v / 1000]]);
  return [
    gauge("cvent_kv_index_up", "Whether the KV index could be listed.", [[{}, 1]]),
    gauge("cvent_kv_index_timestamp_seconds", "When the KV index was last listed.", [[{}, index.at / 1000]]),
    gauge("cvent_kv_events", "Bundled events cached in KV, by status; unknown predates KV metadata.",
      ["ok", "gone", "unknown"].map((s) => [{ status: s }, count(live, (r) => (r.status ?? "unknown") === s)])),
    gauge("cvent_kv_events_orphaned", "KV entries for events no longer in the bundle.", [[{}, index.rows.length - live.length]]),
    gauge("cvent_events_uncached", "Bundled events with no KV entry.", [[{}, events.length - live.length]]),
    gauge("cvent_kv_events_stale", "Cached events past their refresh interval.", [[{}, count(live, stale)]]),
    gauge("cvent_kv_refresh_oldest_timestamp_seconds", "Oldest refresh time among cached events.", ts(Math.min(...ats))),
    gauge("cvent_kv_refresh_newest_timestamp_seconds", "Newest refresh time among cached events.", ts(Math.max(...ats))),
    gauge("cvent_kv_last_change_timestamp_seconds", "Most recent content change among cached events.", ts(Math.max(...changes))),
    gauge("cvent_kv_events_changed", "Cached events whose content changed within a window.",
      WINDOWS.map(([within, ms]) => [{ within }, count(changes, (c) => now - c <= ms)])),
    gauge("cvent_kv_items", "Sessions, speakers and exhibitors across cached events.",
      ["sessions", "speakers", "exhibitors"].map((kind) => [{ kind }, sum(kind)])),
    gauge("cvent_kv_events_empty", "Cached events with no sessions, speakers or exhibitors.",
      [[{}, count(ok, (r) => !r.sessions && !r.speakers && !r.exhibitors)]]),
  ];
}

function build(version) {
  if (!version?.id) return [];
  const at = Date.parse(version.timestamp ?? "");
  return [
    gauge("cvent_build_info", "The deployed Worker version.", [[{ version_id: version.id, version_tag: version.tag ?? "" }, 1]]),
    ...(Number.isFinite(at) ? [gauge("cvent_build_timestamp_seconds", "When the deployed Worker version was uploaded.", [[{}, at / 1000]])] : []),
  ];
}

export const globalFamilies = (events, index, now, version) => [...build(version), ...bundle(events, now), ...cached(events, index, now)];
