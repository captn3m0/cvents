"""Fetch one public event's Sync Gateway docs and summarise fields per type."""
import collections
import json
import sys
import urllib.request
import uuid

FALCON = {"production": "https://falcon-service-prod.us-east-1.lb.cvent.com/pr50/falcon/v1",
          "production-eu": "https://falcon-service-prod.eu-west-1.lb.cvent.com/pr53/falcon/v1"}
SG = {"production": "https://falcon-sg-mobile-pr50-prod.us-east-1.lb.cvent.com/falcon",
      "production-eu": "https://falcon-sg-mobile-pr53-prod.eu-west-1.lb.cvent.com/falcon"}
UA = "cvent/1.0 CventEvents/2.9.0-3612840 (iPhone15,2; ios 18.1)"


def req(url, body=None, headers=None):
    h = {"User-Agent": UA, "Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(url, data, h)) as r:
        return json.load(r)


def fetch(event_id, env="production", access_code=None):
    s = req(f"{FALCON[env]}/events/{event_id}/sync/anonymous?environment={env}&preview=false&livePreview=false",
            {"deviceId": str(uuid.uuid4()), "accessCode": access_code})
    cookie = f"{s['cookie_name']}={s['session_id']}"
    ch = req(f"{SG[env]}/_changes?include_docs=true", headers={"Cookie": cookie})
    return s, ch


if __name__ == "__main__":
    sess, ch = fetch(sys.argv[1], *(sys.argv[2:3] or ["production"]))
    json.dump(ch, open(sys.argv[-1] if sys.argv[-1].endswith(".json") else "/dev/null", "w"))
    keys = collections.defaultdict(set)
    count = collections.Counter()
    for r in ch["results"]:
        d = r.get("doc") or {}
        count[d.get("type")] += 1
        keys[d.get("type")] |= {k for k in d if not k.startswith("_")}
    print(json.dumps(sess["publicChannels"]))
    for t, n in count.most_common():
        print(n, t, sorted(keys[t]))
