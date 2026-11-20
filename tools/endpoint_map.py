"""List path literals used near each service-config lookup in decompiled JS."""
import re
import sys

SVC = re.compile(r"\.(falconService(?:V[234])?|falconLoginService|attendeeLoginWeb|couchbase|"
                 r"graphql|gamificationService|eventAdService|discussionsService)\b")
LIT = re.compile(r"= '((?:/|[a-z]+/)[^' ]{1,120})';")
VERB = re.compile(r"\.(get|post|put|patch|delete|query|json|header|auth)\b")

lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n")
seen = {}
for i, ln in enumerate(lines):
    m = SVC.search(ln)
    if not m:
        continue
    window = lines[i:i + 70]
    paths = [p for w in window for p in LIT.findall(w)]
    verbs = sorted({v for w in window for v in VERB.findall(w)})
    qs = [q for w in window for q in re.findall(r"r\d+ = '([a-zA-Z]+)';\s*$", w)]
    key = (m.group(1), tuple(paths[:4]))
    if paths and key not in seen:
        seen[key] = i + 1
        print(f"{i + 1}\t{m.group(1)}\t{paths[:4]}\t{verbs}\t{qs[:10]}")
