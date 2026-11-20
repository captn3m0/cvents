# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Search for public Cvent events and add events/{id}.yml for each new one."""
import argparse
import datetime as dt
import json
import logging
import pathlib
import re
import sys
import unicodedata

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "generator"))
import cvent_sqlite as cv  # noqa: E402

EXCLUDE = r"\b(test|testing event|demo|sample|sandbox|template|dummy|do not use|copy of)\b"
FIELDS = [("title", "title"), ("start", "startDate"), ("end", "endDate"),
          ("location", "location"), ("city", "city"), ("state", "stateCode"),
          ("country", "countryCode"), ("image", "eventImageUrl")]
log = logging.getLogger("discover")


def slugify(title, eid):
    s = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60].rstrip("-")
    return f"{s or 'event'}-{eid[:8]}"


def quote(v):
    return json.dumps(v, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def to_yaml(card, today):
    lines = [f"id: {card['id']}", f"env: {card['environment']}",
             f"slug: {slugify(card.get('title'), card['id'])}"]
    lines += [f"{k}: {quote(str(card[src]).strip())}" for k, src in FIELDS if str(card.get(src) or "").strip()]
    lines.append(f"discovered: {today}")
    return "\n".join(lines) + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dir", default="events", type=pathlib.Path)
    p.add_argument("--env", action="append", choices=list(cv.ENVS), help="default: all")
    p.add_argument("--term", action="append", help="search term (repeatable); default: built-in list")
    p.add_argument("--past-days", type=int, default=0)
    p.add_argument("--future-days", type=int, default=365)
    p.add_argument("--max-duration-days", type=int, default=31, help="drop longer (demo) events")
    p.add_argument("--exclude", default=EXCLUDE, help="case-insensitive title regex to skip")
    p.add_argument("--max-new", type=int, help="add at most this many events")
    p.add_argument("--workers", type=int, default=4)
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    start, end = now - dt.timedelta(days=a.past_days), now + dt.timedelta(days=a.future_days)

    found = cv.discover(a.env or list(cv.ENVS), a.term or cv.DEFAULT_TERMS, start, end, a.workers)
    skip = re.compile(a.exclude, re.I)
    cards = [c for c in found.values() if cv.is_public(c, start, end, a.max_duration_days)
             and not skip.search(c.get("title") or "")]
    a.dir.mkdir(parents=True, exist_ok=True)
    new = [c for c in sorted(cards, key=lambda c: c["startDate"])
           if not (a.dir / f"{c['id']}.yml").exists()][:a.max_new]
    for c in new:
        (a.dir / f"{c['id']}.yml").write_text(to_yaml(c, now.date().isoformat()), encoding="utf-8")
    log.info("%d public events found, %d new files in %s", len(cards), len(new), a.dir)


if __name__ == "__main__":
    sys.exit(main())
