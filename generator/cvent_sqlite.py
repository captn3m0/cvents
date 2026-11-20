# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build a SQLite database of public Cvent Events data (see API.md)."""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import logging
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from zoneinfo import ZoneInfo

ENVS = {
    "production": ("https://falcon-service-prod.us-east-1.lb.cvent.com/pr50/falcon/v1",
                   "https://falcon-sg-mobile-pr50-prod.us-east-1.lb.cvent.com/falcon"),
    "production-eu": ("https://falcon-service-prod.eu-west-1.lb.cvent.com/pr53/falcon/v1",
                      "https://falcon-sg-mobile-pr53-prod.eu-west-1.lb.cvent.com/falcon"),
}
UA = "cvent/1.0 CventEvents/2.9.0-3612840 (iPhone15,2; ios 18.1)"
SEARCH_CAP = 100
DEFAULT_TERMS = [
    "conference", "summit", "meeting", "forum", "expo", "annual", "symposium",
    "congress", "workshop", "week", "day", "show", "convention", "training",
    "gala", "awards", "event", "festival", "academy", "council", "association",
    "leadership", "partner", "user", "global", "national", "international",
    "health", "tech", "sales", "kickoff", "retreat", "fair", "institute",
    "2026", "2027", "the", "and", "of",
]
PII_KEYS = {"emailAddress", "email", "workPhone", "mobilePhone", "otherPhone"}
SKIP_TYPES = {"ExhibitorStaff", "ExhibitorAnswer", "SessionCapacity", "AttendeeLocal"}
log = logging.getLogger("cvent")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, environment TEXT, title TEXT, description_html TEXT,
  start_date TEXT, end_date TEXT, start_local TEXT, end_local TEXT, zone_id TEXT,
  attending_format TEXT, location TEXT, address1 TEXT, address2 TEXT, address3 TEXT,
  city TEXT, state_code TEXT, postal_code TEXT, country_code TEXT,
  latitude REAL, longitude REAL, image_url TEXT, culture_code TEXT,
  sync_status TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, event_id TEXT, name TEXT, code TEXT, description_html TEXT,
  start_time TEXT, end_time TEXT, start_local TEXT, end_local TEXT,
  category_id TEXT, category_name TEXT, location_id TEXT, location_name TEXT,
  is_featured INTEGER, display_order INTEGER);
CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY, event_id TEXT, prefix TEXT, first_name TEXT, last_name TEXT,
  title TEXT, company TEXT, designation TEXT, biography_html TEXT, image_url TEXT,
  linkedin_url TEXT, twitter_url TEXT, facebook_url TEXT, is_featured INTEGER,
  display_order INTEGER);
CREATE TABLE IF NOT EXISTS session_speakers (
  session_id TEXT, speaker_id TEXT, event_id TEXT, PRIMARY KEY (session_id, speaker_id));
CREATE TABLE IF NOT EXISTS exhibitors (
  id TEXT PRIMARY KEY, event_id TEXT, name TEXT, description_html TEXT, booth TEXT,
  website_url TEXT, virtual_booth_url TEXT, image_url TEXT, sponsorship_level_id TEXT,
  is_featured INTEGER, is_sponsor INTEGER);
CREATE TABLE IF NOT EXISTS sponsorship_levels (
  id TEXT PRIMARY KEY, event_id TEXT, name TEXT, rank INTEGER);
CREATE TABLE IF NOT EXISTS locations (
  id TEXT, event_id TEXT, name TEXT, code TEXT, PRIMARY KEY (id, event_id));
CREATE TABLE IF NOT EXISTS categories (
  id TEXT, event_id TEXT, name TEXT, PRIMARY KEY (id, event_id));
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, event_id TEXT, type TEXT, json TEXT);
CREATE INDEX IF NOT EXISTS sessions_event ON sessions (event_id, start_time);
CREATE INDEX IF NOT EXISTS speakers_event ON speakers (event_id);
CREATE INDEX IF NOT EXISTS exhibitors_event ON exhibitors (event_id);
CREATE INDEX IF NOT EXISTS docs_event_type ON docs (event_id, type);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (
  kind UNINDEXED, id UNINDEXED, event_id UNINDEXED, title, body);
"""
EVENT_TABLES = ["sessions", "speakers", "session_speakers", "exhibitors",
                "sponsorship_levels", "locations", "categories", "docs", "search"]


def http_json(url, body=None, headers=None, retries=4):
    h = {"User-Agent": UA, "Accept": "application/json", **(headers or {})}
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        h["Content-Type"] = "application/json"
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data, h), timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429 or attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        time.sleep(2 ** attempt)


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def parse_ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def search(env, term, start, end):
    q = urllib.parse.urlencode({"environment": env, "isFullSearch": "true",
                                "fromDate": iso(start), "toDate": iso(end)})
    res = http_json(f"{ENVS[env][0]}/events/search?{q}",
                    {"searchTerm": term, "limit": SEARCH_CAP, "appId": None})
    return res.get("eventSearchResults", [])


def sweep(env, term, start, end, min_window):
    hits = search(env, term, start, end)
    if len(hits) < SEARCH_CAP or end - start <= min_window:
        if len(hits) >= SEARCH_CAP:
            log.warning("cap hit for %r %s %s..%s", term, env, start.date(), end.date())
        return hits
    mid = start + (end - start) / 2
    return sweep(env, term, start, mid, min_window) + sweep(env, term, mid, end, min_window)


def discover(envs, terms, start, end, workers, window_days=30):
    windows, w = [], start
    while w < end:
        windows.append((w, min(w + dt.timedelta(days=window_days), end)))
        w = windows[-1][1]
    jobs = [(e, t, a, b) for e in envs for t in terms for a, b in windows]
    found = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(sweep, e, t, a, b, dt.timedelta(days=1)): (e, t) for e, t, a, b in jobs}
        for f in cf.as_completed(futs):
            env, term = futs[f]
            try:
                for card in f.result():
                    found.setdefault(card["id"], {**card, "environment": env})
            except Exception as e:
                log.error("search %s %r failed: %s", env, term, e)
    log.info("discovered %d unique events from %d searches", len(found), len(jobs))
    return found


def is_public(card, start, end, max_days):
    s, e = parse_ts(card.get("startDate")), parse_ts(card.get("endDate"))
    if not s or not e or card.get("isLoginRequired") or card.get("isAccessCodeRequired"):
        return False
    return e >= start and s <= end and (e - s).days <= max_days


def fetch_docs(env, event_id, page=1000):
    falcon, sg = ENVS[env]
    q = urllib.parse.urlencode({"environment": env, "preview": "false", "livePreview": "false"})
    s = http_json(f"{falcon}/events/{event_id}/sync/anonymous?{q}",
                  {"deviceId": str(uuid.uuid4()), "accessCode": None})
    cookie = {"Cookie": f"{s['cookie_name']}={s['session_id']}"}
    docs, since = {}, None
    while True:
        params = {"include_docs": "true", "limit": page, "filter": "sync_gateway/bychannel",
                  "channels": f"production::event::{event_id}"}
        if since is not None:
            params["since"] = since
        res = http_json(f"{sg}/_changes?{urllib.parse.urlencode(params)}", headers=cookie)
        for row in res.get("results", []):
            d = row.get("doc")
            if d and d.get("type") and not row.get("deleted") and not d.get("_deleted"):
                docs[d["_id"]] = d
            elif row.get("deleted"):
                docs.pop(row.get("id"), None)
        if len(res.get("results", [])) < page:
            return list(docs.values())
        since = res["last_seq"]


def local(ts, zone):
    try:
        return parse_ts(ts).astimezone(ZoneInfo(zone)).isoformat() if ts and zone else None
    except Exception:
        return None


def truthy_deleted(v):
    return v not in (None, False, "", "false", "0", 0)


def store_event(db, card, docs, now):
    eid, env = card["id"], card["environment"]
    for t in EVENT_TABLES:
        db.execute(f"DELETE FROM {t} WHERE event_id = ?", (eid,))
    by_type = {}
    for d in docs:
        by_type.setdefault(d["type"], []).append(d)
    ev = (by_type.get("Event") or [{}])[0]
    zone = ev.get("zoneId")
    db.execute("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        eid, env, ev.get("title") or card.get("title"),
        ev.get("description") or card.get("description"),
        ev.get("startDate") or card.get("startDate"), ev.get("endDate") or card.get("endDate"),
        local(ev.get("startDate") or card.get("startDate"), zone),
        local(ev.get("endDate") or card.get("endDate"), zone), zone,
        ev.get("attendingFormat"), ev.get("location") or card.get("location"),
        ev.get("address1"), ev.get("address2"), ev.get("address3"),
        ev.get("city") or card.get("city"), ev.get("stateCode") or card.get("stateCode"),
        ev.get("postalCode") or card.get("postalCode"),
        ev.get("countryCode") or card.get("countryCode"), ev.get("latitude"),
        ev.get("longitude"), card.get("eventImageUrl"), ev.get("cultureCode"),
        "ok" if ev else "no-event-doc", now))
    db.execute("INSERT INTO search VALUES ('event',?,?,?,?)",
               (eid, eid, ev.get("title") or card.get("title"), ev.get("description") or ""))
    for d in docs:
        if d["type"] in SKIP_TYPES:
            continue
        clean = {k: v for k, v in d.items() if k not in PII_KEYS and not k.startswith("_")}
        db.execute("INSERT OR REPLACE INTO docs VALUES (?,?,?,?)",
                   (d["_id"], eid, d["type"], json.dumps(clean, ensure_ascii=False)))
    speakers = {}
    for s in by_type.get("Speaker", []):
        if s.get("isDisplayOnWebsite") is False:
            continue
        speakers[s["id"]] = s
        db.execute("INSERT OR REPLACE INTO speakers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            s["id"], eid, s.get("prefix"), s.get("firstName"), s.get("lastName"),
            s.get("title"), s.get("company"), s.get("designation"), s.get("biography"),
            s.get("profileImage"), s.get("linkedInProfile"), s.get("twitterProfile"),
            s.get("facebookProfile"), int(bool(s.get("isFeaturedSpeaker"))), s.get("order")))
        name = " ".join(filter(None, [s.get("firstName"), s.get("lastName")]))
        body = " ".join(filter(None, [s.get("title"), s.get("company"), s.get("biography")]))
        db.execute("INSERT INTO search VALUES ('speaker',?,?,?,?)", (s["id"], eid, name, body))
    for s in by_type.get("Session", []):
        if s.get("displayOnAgenda") is False or s.get("restrictSessionVisibility"):
            continue
        db.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            s["id"], eid, s.get("name"), s.get("code"),
            s.get("richTextDescription") or s.get("description"),
            s.get("startTime"), s.get("endTime"), local(s.get("startTime"), zone),
            local(s.get("endTime"), zone), s.get("categoryId"), s.get("categoryName"),
            s.get("locationId"), s.get("locationName"),
            int(bool(s.get("isFeaturedSession"))), s.get("displayOrder")))
        if s.get("categoryId") and (s.get("categoryName") or "").strip():
            db.execute("INSERT OR IGNORE INTO categories VALUES (?,?,?)",
                       (s["categoryId"], eid, s["categoryName"].strip()))
        if s.get("locationId") and s.get("locationName"):
            db.execute("INSERT OR IGNORE INTO locations VALUES (?,?,?,?)",
                       (s["locationId"], eid, s["locationName"], s.get("locationCode")))
        for sp in s.get("speakers") or []:
            if sp in speakers:
                db.execute("INSERT OR IGNORE INTO session_speakers VALUES (?,?,?)", (s["id"], sp, eid))
        db.execute("INSERT INTO search VALUES ('session',?,?,?,?)",
                   (s["id"], eid, s.get("name"), s.get("description") or ""))
    falcon = ENVS[env][0]
    for x in by_type.get("Exhibitor", []):
        if x.get("hidden") or truthy_deleted(x.get("deleted")):
            continue
        img = (f"{falcon}/assets/{eid}/exhibitorprofile/{x['profileId']}"
               f"?environment={env}&imageSize=200") if x.get("profileId") else None
        level = x.get("sponsorshipLevelId") or next(iter(x.get("sponsorshipLevelIds") or []), None)
        db.execute("INSERT OR REPLACE INTO exhibitors VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
            x["id"], eid, x.get("name"), x.get("description"), x.get("location"),
            x.get("websiteUrl"), x.get("virtualBoothUrl"), img, level,
            int(bool(x.get("featured"))), int(bool(x.get("eventSponsor")))))
        db.execute("INSERT INTO search VALUES ('exhibitor',?,?,?,?)",
                   (x["id"], eid, x.get("name"), x.get("description") or ""))
    for lv in by_type.get("SponsorshipLevel", []):
        if not truthy_deleted(lv.get("deleted")):
            db.execute("INSERT OR REPLACE INTO sponsorship_levels VALUES (?,?,?,?)",
                       (lv["id"], eid, lv.get("name"), lv.get("rank")))
    for d in by_type.get("SessionLocations", []) + by_type.get("Location", []) + by_type.get("SessionLocation", []):
        for loc in d.get("locations") or [d]:
            db.execute("INSERT OR REPLACE INTO locations VALUES (?,?,?,?)",
                       (loc["id"], eid, loc.get("name"), loc.get("code")))
    for d in by_type.get("SessionCategories", []):
        for c in d.get("categories") or []:
            if (c.get("name") or "").strip():
                db.execute("INSERT OR REPLACE INTO categories VALUES (?,?,?)", (c["id"], eid, c["name"].strip()))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default="cvent.sqlite")
    p.add_argument("--env", action="append", choices=list(ENVS), help="default: all")
    p.add_argument("--term", action="append", help="search term (repeatable); default: built-in list")
    p.add_argument("--event", action="append", help="ENV:EVENT_ID to fetch directly, skipping search")
    p.add_argument("--past-days", type=int, default=30, help="include events that ended this recently")
    p.add_argument("--future-days", type=int, default=365)
    p.add_argument("--max-duration-days", type=int, default=31, help="drop longer (demo) events")
    p.add_argument("--max-events", type=int, help="stop after this many events (for testing)")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    start, end = now - dt.timedelta(days=a.past_days), now + dt.timedelta(days=a.future_days)

    if a.event:
        cards = {}
        for spec in a.event:
            env, eid = spec.split(":", 1)
            cards[eid] = {**http_json(f"{ENVS[env][0]}/events/search/{eid}?environment={env}"),
                          "environment": env}
    else:
        found = discover(a.env or list(ENVS), a.term or DEFAULT_TERMS, start, end, a.workers)
        cards = {k: v for k, v in found.items() if is_public(v, start, end, a.max_duration_days)}
        log.info("%d public events in range", len(cards))
    todo = sorted(cards.values(), key=lambda c: c["startDate"])[:a.max_events]

    db = sqlite3.connect(a.db)
    db.executescript(SCHEMA)
    stamp = iso(now)
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(fetch_docs, c["environment"], c["id"]): c for c in todo}
        for i, f in enumerate(cf.as_completed(futs), 1):
            card = futs[f]
            try:
                docs = f.result()
            except Exception as e:
                log.error("sync %s (%s) failed: %s", card["id"], card.get("title"), e)
                continue
            with db:
                store_event(db, card, docs, stamp)
            log.info("[%d/%d] %s: %d docs", i, len(todo), card.get("title"), len(docs))
    with db:
        db.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [
            ("generated_at", stamp), ("source", "Cvent Events iOS 2.9.0 sync API"),
            ("window", f"{iso(start)}..{iso(end)}")])
    counts = {t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
              for t in ["events", "sessions", "speakers", "exhibitors", "docs"]}
    log.info("wrote %s: %s", a.db, counts)
    db.close()


if __name__ == "__main__":
    sys.exit(main())
