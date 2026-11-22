## How it works

1. A daily GitHub Actions run (`.github/workflows/site.yml`) searches for public
   events and writes one `events/{id}.yml` per event, then deploys.
2. A Cloudflare Worker (`worker/src/`) fetches each event's data live from Cvent's
   Sync Gateway when a page is requested, and caches it in memory, the colo cache
   and KV. Data refreshes hourly from three days before an event, otherwise every
   six hours.

[`API.md`](API.md) explains the reverse-engineered API, documented using
[`openapi.yaml`](openapi.yaml)  as well.

## Layout

| Path | What |
|---|---|
| `events/` | One YAML file per event. Set `hidden: true` to drop one. |
| `scripts/discover.py` | Search sweep that adds and refreshes `events/*.yml`. |
| `scripts/build-events.mjs` | Bundles `events/*.yml` for the Worker. |
| `worker/src/` | Worker: routing, data fetching, rendering, ICS, sanitising. |
| `generator/cvent_sqlite.py` | Standalone exporter to a SQLite database. |
| `tools/` | Reverse-engineering helpers used to map the API. |
| `re/samples/` | Captured API responses (contact data removed), used by tests. |
| `test/` | Node tests run before every deploy. |

## Development

```sh
npm ci
npm test                   # builds the event bundle and runs the tests
npx wrangler dev           # local Worker on http://localhost:8787
uv run scripts/discover.py --env production --term summit --max-new 5
uv run generator/cvent_sqlite.py --db cvent.sqlite --term summit --max-events 5
```

Deploys need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
`production` GitHub environment. The Worker, its domain, KV namespace and the
deploy token are managed in Terraform outside this repository.