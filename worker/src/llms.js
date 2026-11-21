export function llmsTxt(origin) {
  return `# Event schedules

> Unofficial, readable mirror of public event schedules published through the Cvent Events app: agendas, sessions, speakers and exhibitors as plain HTML, with structured data and calendar feeds. Not affiliated with Cvent. Contact details are not published.

## Pages

- [Upcoming events](${origin}/): events that have not ended yet
- [Past events](${origin}/past/): events that ended; their schedules stay available
- [Sitemap index](${origin}/sitemap.xml): one sitemap per event, with lastmod set to the last real content change
- [API documentation](${origin}/api/): OpenAPI description of the upstream Cvent Events app API
- [OpenAPI spec](https://raw.githubusercontent.com/captn3m0/cvents/main/openapi.yaml)
- [Source and README](https://github.com/captn3m0/cvents)

## URL layout

- \`/e/{slug}/\`: event agenda, grouped by day, in the event's local time zone
- \`/e/{slug}/sessions/{id}\`: one session with room, category and speakers
- \`/e/{slug}/speakers/\` and \`/e/{slug}/speakers/{id}\`: speaker list and profiles
- \`/e/{slug}/exhibitors/\`: exhibitors and sponsors grouped by sponsorship level
- \`/e/{slug}/calendar.ics\`: calendar feed
- \`/e/{slug}/sitemap.xml\`: all indexable URLs of one event

## Calendar feeds (ICS)

- Each event has \`/e/{slug}/calendar.ics\` (RFC 5545, \`text/calendar\`), also advertised on event pages with \`<link rel="alternate" type="text/calendar">\`.
- One VEVENT per session, with UID \`{session id}@{host}\`, UTC DTSTART/DTEND, LOCATION (room, venue), CATEGORIES, speakers and the page URL in DESCRIPTION. Events with no sessions get a single VEVENT for the whole event.
- The calendar declares X-WR-TIMEZONE with the event's zone, plus REFRESH-INTERVAL and X-PUBLISHED-TTL of 6 hours.
- A day after an event ends the feed returns 410 Gone. Prefer the HTML pages for past events.

## Structured data (JSON-LD, schema.org)

- Event page: \`Event\` with name, url, startDate, endDate, description, image, eventStatus, eventAttendanceMode (Offline, Online or Mixed), location (\`Place\` with \`PostalAddress\`, or \`VirtualLocation\`; hybrid events list both), up to 20 \`performer\` Persons and up to 10 \`subEvent\` sessions.
- Session page: \`Event\` with startDate, endDate, location, performer Persons, and \`superEvent\` pointing at the parent event's \`@id\` (\`{event url}#event\`).
- Speaker page: \`Person\` with jobTitle, worksFor, description, sameAs (public profile links) and \`performerIn\` (the event and their sessions).
- All pages except the home page also carry a \`BreadcrumbList\`.
- Dates are ISO 8601 in UTC; use the event's zone, shown on the page, for local times.

## Notes

- Data is fetched live from the public app API and refreshed hourly from three days before an event, otherwise every six hours.
- Responses carry ETag and Last-Modified; conditional requests get 304.
- Event pages with no sessions, speakers or exhibitors are marked noindex and left out of sitemaps.
`;
}
