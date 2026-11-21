#!/usr/bin/env bash
# Submit the home pages and any event added or changed in the last commit to IndexNow (Bing, Yandex, Naver, Seznam, Yep).
set -euo pipefail
host=${SITE_HOST:-cvents.bb8.fun}
key=${INDEXNOW_KEY:?INDEXNOW_KEY is required}
urls=("https://$host/" "https://$host/past/")
while IFS= read -r f; do
  [ -f "$f" ] && ! grep -q '^hidden: true' "$f" || continue
  slug=$(sed -n 's/^slug: *//p' "$f" | head -1)
  [ -n "$slug" ] && urls+=("https://$host/e/$slug/")
done < <(git diff --name-only --diff-filter=AM HEAD~1 HEAD -- events 2>/dev/null || true)
body=$(printf '%s\n' "${urls[@]}" | jq -Rn --arg host "$host" --arg key "$key" \
  '{host: $host, key: $key, keyLocation: "https://\($host)/\($key).txt", urlList: [inputs]}')
if [ -n "${DRY_RUN:-}" ]; then echo "$body"; exit 0; fi
curl -fsS -X POST https://api.indexnow.org/IndexNow -H 'content-type: application/json; charset=utf-8' -d "$body"
echo "Submitted ${#urls[@]} URLs"
