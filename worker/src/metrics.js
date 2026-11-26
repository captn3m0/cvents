// Prometheus registry for one isolate; scrapes reach an arbitrary isolate, so every series carries its id and colo.
const families = [];
const self = { isolate: "", colo: "", started: 0 };

const safe = (fn) => (...args) => {
  try {
    fn(...args);
  } catch (e) {
    console.error("metrics", e.message);
  }
};

function family(type, name, help, extra = {}) {
  const f = { type, name, help, series: new Map(), ...extra };
  families.push(f);
  return f;
}

function series(f, labels) {
  const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  let s = f.series.get(key);
  if (!s) f.series.set(key, (s = { labels, value: 0, counts: (f.buckets ?? []).map(() => 0), sum: 0 }));
  return s;
}

export function counter(name, help) {
  const f = family("counter", name, help);
  return { inc: safe((labels = {}, by = 1) => { series(f, labels).value += by; }) };
}

export function histogram(name, help, buckets) {
  const f = family("histogram", name, help, { buckets });
  const observe = safe((labels, seconds) => {
    const s = series(f, labels);
    f.buckets.forEach((le, i) => { if (seconds <= le) s.counts[i]++; });
    s.value++;
    s.sum += seconds;
  });
  const start = () => {
    const t = Date.now();
    return (labels = {}) => observe(labels, (Date.now() - t) / 1000);
  };
  return { observe, start };
}

export const gauge = (name, help, collect) => { family("gauge", name, help, { collect }); };

export function begin(req) {
  if (self.isolate) return;
  self.isolate = crypto.randomUUID().slice(0, 8);
  self.colo = req.cf?.colo ?? "unknown";
  self.started = Date.now();
}

const NET = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

gauge("cvent_isolate_start_time_seconds", "When this isolate served its first request.", () => self.started / 1000);
export const httpRequests = counter("cvent_http_requests_total", "Requests served, by route, method and status.");
export const errors = counter("cvent_errors_total", "Exceptions caught while serving, by where they happened.");
export const loads = counter("cvent_event_loads_total", "Event data lookups, by where the data came from.");
export const loadTime = histogram("cvent_event_load_duration_seconds", "Wall time to load event data, including cache, KV and upstream waits.",
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
export const refreshes = counter("cvent_refreshes_total", "Event data refreshes from Cvent, by result.");
export const refreshTime = histogram("cvent_refresh_duration_seconds", "Wall time of event data refreshes, by result.", [...NET, 60]);
export const refreshContent = counter("cvent_refresh_content_total", "Successful refreshes, by whether the content hash changed.");
export const refreshJoins = counter("cvent_refresh_joins_total", "Lookups that waited on a refresh already in flight.");
export const upstream = counter("cvent_upstream_requests_total", "Requests to Cvent and image hosts, by service and status.");
export const upstreamTime = histogram("cvent_upstream_request_duration_seconds", "Wall time until upstream response headers, by service.", NET);
export const imagesRejected = counter("cvent_images_rejected_total", "Upstream images dropped for a bad status, type or size, by service.");
export const changesPages = counter("cvent_changes_pages_total", "Pages read from the Sync Gateway _changes feed.");
export const changesDocs = counter("cvent_changes_docs_total", "Rows read from the Sync Gateway _changes feed, by kind.");
export const sessions = counter("cvent_sync_sessions_total", "Anonymous sync session cookies, by source.");
export const sessionRetries = counter("cvent_sync_session_retries_total", "Feed reads retried with a new session after a 401.");
export const kvOps = counter("cvent_kv_operations_total", "KV operations, by operation and result.");
export const cacheOps = counter("cvent_cache_operations_total", "Colo cache operations, by kind, operation and result.");
export const memEvictions = counter("cvent_mem_evictions_total", "Events evicted from the in-memory LRU.");
export const ogRenders = counter("cvent_og_renders_total", "Open Graph images rendered, by kind and result.");

export async function upstreamFetch(service, input, init) {
  const stop = upstreamTime.start();
  try {
    const res = await fetch(input, init);
    upstream.inc({ service, status: String(res.status) });
    return res;
  } catch (e) {
    upstream.inc({ service, status: e.name === "TimeoutError" ? "timeout" : "error" });
    throw e;
  } finally {
    stop({ service });
  }
}

const ROUTES = [
  [/^\/$/, "home"], [/^\/past\/?$/, "past"], [/^\/api\/?$/, "api"], [/^\/og\/[^/]+\.png$/, "og"], [/^\/logo\/[^/]+$/, "logo"],
  [/^\/llms\.txt$/, "llms"], [/^\/robots\.txt$/, "robots"], [/^\/sitemap\.xml$/, "sitemap"], [/^\/sitemaps\/events\.xml$/, "sitemap_events"],
  [/^\/metrics$/, "metrics"], [/^\/metrics\/authenticated$/, "metrics_authenticated"], [/^\/[0-9a-f]{32}\.txt$/, "indexnow"],
  [/^\/e\/[^/]+\/?$/, "event"], [/^\/e\/[^/]+\/calendar\.ics$/, "event_ics"], [/^\/e\/[^/]+\/sitemap\.xml$/, "event_sitemap"],
  [/^\/e\/[^/]+\/speakers\/?$/, "event_speakers"], [/^\/e\/[^/]+\/exhibitors\/?$/, "event_exhibitors"],
  [/^\/e\/[^/]+\/sessions\/[^/]+\/?$/, "event_session"], [/^\/e\/[^/]+\/speakers\/[^/]+\/?$/, "event_speaker"], [/^\/e\//, "event_other"],
];
export const routeName = (path) => ROUTES.find(([re]) => re.test(path))?.[1] ?? "other";

// Grafana Cloud only scrapes endpoints behind auth, so this wraps /metrics with bearer or basic auth.
export const authorized = (header) => /^(basic|bearer)\s+\S/i.test(header ?? "");

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const fmt = (labels) => {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "";
};
const num = (v) => (Number.isFinite(v) ? String(v) : Number.isNaN(v) ? "NaN" : v > 0 ? "+Inf" : "-Inf");

function block(f, base) {
  const rows = [];
  const put = (name, labels, v) => rows.push(`${name}${fmt({ ...base, ...labels })} ${num(v)}`);
  if (f.type === "histogram") {
    for (const s of f.series.values()) {
      f.buckets.forEach((le, i) => put(`${f.name}_bucket`, { ...s.labels, le }, s.counts[i]));
      put(`${f.name}_bucket`, { ...s.labels, le: "+Inf" }, s.value);
      put(`${f.name}_sum`, s.labels, s.sum);
      put(`${f.name}_count`, s.labels, s.value);
    }
  } else {
    const got = f.collect ? f.collect() : f.samples ?? [...f.series.values()].map((s) => [s.labels, s.value]);
    for (const [labels, v] of Array.isArray(got) ? got : [[{}, got]]) put(f.name, labels, v);
  }
  return rows.length ? [`# HELP ${f.name} ${f.help}`, `# TYPE ${f.name} ${f.type}`, ...rows] : [];
}

export function exposition(global = []) {
  const base = { isolate: self.isolate, colo: self.colo };
  return [...families.flatMap((f) => block(f, base)), ...global.flatMap((f) => block(f, {}))].join("\n") + "\n";
}
