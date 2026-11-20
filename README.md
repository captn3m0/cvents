# cvents

Readable, indexable schedules for public events published through the
Cvent Events app, without installing the app.

**Site:** <https://cvents.bb8.fun> · **API docs:** <https://cvents.bb8.fun/api/>

> :warning: Unofficial and not affiliated with Cvent. Event content belongs to the
> organisers who published it; this project only mirrors what the app shows
> to anyone without logging in.

## What it does

- Finds public events (no login, no access code) through the app's search API.
- Serves each event's agenda, sessions, speakers and exhibitors as plain HTML,
  with schema.org data, Open Graph tags and sitemaps.
- Offers a calendar feed per event (`/e/{slug}/calendar.ics`) and a subscribe
  button. Feeds stop being served a day after the event ends.
- Leaves out contact details (emails, phone numbers) and anything the app hides.

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

## License

Code and documentation are released into the public domain under the
[Unlicense](LICENSE). This does not cover third-party content: event data from
Cvent and its organisers, including the captured samples in `re/samples/`.
