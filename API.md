# Cvent Events API notes

Source: Cvent Events iOS 2.9.0 (`id1491335576`, build 3612840), React Native
with Hermes bytecode v98. Formal spec: [`openapi.yaml`](openapi.yaml).
Everything below marked "verified" was called against production on 2026-11-20.

## Flow (what the app does)

1. **Search** `POST {falcon}/events/search` → event cards. *(verified, no auth)*
2. **Select event** → `POST {falcon}/events/{id}/sync/anonymous` → Sync Gateway
   cookie session with `publicChannels`. *(verified for public events)*
3. **Replicate** the channels from Couchbase Sync Gateway
   (`wss://…/falcon`, db `falcon`) into a local Couchbase Lite DB.
4. **Schedule, speakers, exhibitors** are N1QL queries on that local DB,
   e.g. `SELECT * FROM _ WHERE type == "Session"`.

No per-screen REST calls exist for event content. Step 3 can be replaced by
Sync Gateway's plain REST API: `GET {sg}/_changes?include_docs=true` with the
session cookie returns every document. *(verified)*

## Hosts

| env (`environment=`) | falcon REST | Sync Gateway |
|---|---|---|
| `production` (pr50, US) | `https://falcon-service-prod.us-east-1.lb.cvent.com/pr50/falcon/v1` | `https://falcon-sg-mobile-pr50-prod.us-east-1.lb.cvent.com/falcon` |
| `production-eu` (pr53, EU) | `https://falcon-service-prod.eu-west-1.lb.cvent.com/pr53/falcon/v1` | `https://falcon-sg-mobile-pr53-prod.eu-west-1.lb.cvent.com/falcon` |

The app searches both environments (`IS_MULTI_ENVIRONMENT_SEARCH=true`), and
each event lives in exactly one. Use the matching Sync Gateway.

Other hosts in the config, not needed for public content: `falcon/v2..v4`
(attendee profile, PubNub auth), `web.cvent.com/attendee-login/api/v1` (login),
`attendee-hub-graph-*/api/graphql` (Attendee Hub GraphQL), gamification,
discussions, `event-ad-service`, `io.cvent.com` (analytics).

## Search

```
POST /events/search?environment=production&isFullSearch=true&fromDate=2026-12-01T00:00:00.000Z&toDate=2026-12-31T00:00:00.000Z
{"searchTerm": "conference", "limit": 100, "appId": null}
```

- `searchTerm` is required and non-empty. `limit` is at most 100. There is no offset.
- `fromDate` only: events ending on/after it. `toDate` only: events ending
  before it, newest first. Both: a window. Use windows to page.
- `isFullSearch` shows no observable effect.
- Each result has `isLoginRequired` and `isAccessCodeRequired`. Only events with
  both `false` are public.
- `GET /events/search/{eventId}?environment=…` returns one card.
- `POST /events/search/list` needs a branded app's `appId` (422 otherwise).
- There is no "list all events" endpoint: `eventdiscovery/events` is a
  deep-link route, not an API.

## Sync session

```
POST /events/{eventId}/sync/anonymous?environment=production&preview=false&livePreview=false
{"deviceId": "<random uuid>", "accessCode": null}
→ {"cookie_name":"SyncGatewaySession","session_id":"…","expires":"…+24h",
   "publicChannels":["production::event::{eventId}","production::account::{acct}",
                     "production::account::{acct}::translations","production::global"],
   "authenticatedChannels":[]}
```

Send it as the `Cookie: SyncGatewaySession=<session_id>` header to the Sync Gateway.
Access-code events take `accessCode` in the body; login events use
`/sync/user` with a bearer token. Both were read from code only and not called.

## Sync Gateway REST

- `GET /_changes?include_docs=true[&limit=N&since=<last_seq>]` returns all
  readable docs. Narrow it with `filter=sync_gateway/bychannel&channels=production::event::{id}`.
- `GET /{docId}` returns one doc.
- `GET /_all_docs` returns 504. Without a cookie you get 401.
- One session can read the shared `global`/`account` channels, so expect
  `Category` and translation docs from outside the event.

## Document model

`_id` = `production::falcon-data-service::{type}::{id}`, and every doc has `type`,
`id`, `eventId`, `channels`, `version`. The main types for a public site:

| type | key fields |
|---|---|
| `Event` | title, description (HTML), startDate, endDate, zoneId, location, address, lat/long |
| `Session` | name, description, startTime, endTime, categoryId/Name, locationId/Name, `speakers[]` (ids), tags, documents |
| `Speaker` | prefix, firstName, lastName, title, company, biography, profileImage, social links, order |
| `Exhibitor` | name, description, location (booth), profileId, sponsorshipLevelId(s), urls |
| `SponsorshipLevel` | name, rank |
| `SessionLocations` / `Location` | room id, code, name |
| `SessionCategories` / `Category` | id, name |
| `CustomPage` | name, sections (draft.js JSON) |
| `InteractiveFloorPlan` | image url, markers |
| `EventLocale`, `EventTranslation`, `LanguageOverrides` | i18n |

Times are UTC ISO-8601. Render them in `Event.zoneId`.
Exhibitor images: `GET {falcon}/assets/{eventId}/exhibitorprofile/{profileId}?environment=…&imageSize=200`.
Speaker and event images are absolute `custom.cvent.com` / `images.cvent.com` URLs.

## Caveats for republishing

- `Speaker.emailAddress` and exhibitor phones/emails appear in public channels.
  Don't republish personal contact data.
- `Session.restrictSessionVisibility`, `displayOnAgenda=false` and
  `Speaker.isDisplayOnWebsite=false` mark content hidden in the app. Honour them.
- Search returns many demo or test events (e.g. "2022 Educational Conference"
  running 2010–2109). Filter on dates.
- Every value here comes from untrusted remote content. Escape HTML fields.

## Generator

```
uv run generator/cvent_sqlite.py --db cvent.sqlite              # full sweep
uv run generator/cvent_sqlite.py --env production --term summit --future-days 60 --max-events 5
uv run generator/cvent_sqlite.py --event production:<eventId>   # skip search
```

Search sweeps every term × env × 30-day window, and splits a window when it hits
the 100 cap. The default list (39 terms, 2 envs, 13 windows) is about 1000 searches,
plus 2+ requests per event. Narrow it with `--term`, `--env` and `--future-days`.
Tables: `events`, `sessions`, `speakers`, `session_speakers`, `exhibitors`,
`sponsorship_levels`, `locations`, `categories`, `docs` (raw JSON, PII
stripped) and `search` (FTS5). Reruns replace each event's rows.

## Site (Cloudflare Worker)

- `scripts/discover.py` runs the search sweep and writes `events/{id}.yml` for
  each new public event (id, env, slug, title, dates, place). Existing files are
  never rewritten. To drop an event, set `hidden: true`; deleting the file lets
  the next run add it back.
- `.github/workflows/site.yml` runs discovery daily, commits new files, then runs
  `npm test` and `wrangler deploy`. The deploy job uses the `production`
  environment, which holds the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
- `worker/src/` fetches each event live (anonymous session, then `_changes`),
  keeps only rendered fields, sanitises HTML and caches for 15 minutes. Stale data
  is served while it refreshes. Events that stop being public return 410.
- Routes: `/`, `/past/`, `/e/{slug}/`, `/e/{slug}/sessions/{id}`,
  `/e/{slug}/speakers/[{id}]`, `/e/{slug}/exhibitors/`. `/sitemap.xml` is an index
  of `/sitemaps/events.xml` plus one `/e/{slug}/sitemap.xml` per event.
- It is served on `cvents.bb8.fun`, not `workers.dev`, where the Cache API does
  nothing. The script, domain and token are in `nebula/cloudflare/cvent.tf`.

```
uv run scripts/discover.py --env production --term summit --max-new 5
npm test && npx wrangler dev
```

## Repo layout

- `ipa/`, `re/strings.jsonl`, `re/main.decompiled.js`: the app and its decompiled
  bundle. They stay local and are not committed.
- `re/samples/`: captured responses (search, sync session, `_changes`) with contact
  data removed. The tests use them.
- `tools/hbc_strings.py`: string-table dumper. `tools/endpoint_map.py`: service→path map.
- `tools/probe_event.py`: fetches one public event and summarises its doc types.
