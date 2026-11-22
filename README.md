# cvents

Readable, indexable schedules for public events published through the
Cvent app, without installing the app.

**Site:** <https://cvents.bb8.fun> · **API docs:** <https://cvents.bb8.fun/api/>

> :warning: Unofficial and not affiliated with Cvent. Event content belongs to the
> organisers who published it; this project only mirrors what the app shows
> to anyone without logging in.

## What it does

- Finds public events through the app's search API.
- Serves each event's agenda, sessions, speakers and exhibitors as plain HTML,
  with schema.org data, Open Graph tags and sitemaps.
- Offers a calendar feed per event (`/e/{slug}/calendar.ics`) and a subscribe
  button.
- Leaves out contact details (emails, phone numbers) and anything the app hides.

## License

Code and documentation are released into the public domain under the
[Unlicense](LICENSE). This does not cover third-party content: event data from
Cvent and its organisers, including the captured samples in `re/samples/`.
