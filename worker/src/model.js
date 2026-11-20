// Turn raw Sync Gateway docs into the fields the site renders; nothing else is kept.
export const ENVS = {
  production: [
    "https://falcon-service-prod.us-east-1.lb.cvent.com/pr50/falcon/v1",
    "https://falcon-sg-mobile-pr50-prod.us-east-1.lb.cvent.com/falcon",
  ],
  "production-eu": [
    "https://falcon-service-prod.eu-west-1.lb.cvent.com/pr53/falcon/v1",
    "https://falcon-sg-mobile-pr53-prod.eu-west-1.lb.cvent.com/falcon",
  ],
};

const str = (v) => (typeof v === "string" ? v.trim() : "");
const deleted = (v) => ![undefined, null, false, "", "false", "0", 0].includes(v);
const url = (v) => (/^https?:\/\//i.test(str(v)) ? str(v) : "");

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function textToHtml(s) {
  s = str(s);
  if (!s) return "";
  if (/<\/?[a-z][^>]*>/i.test(s)) return s;
  return s.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

export function normalise(entry, docs) {
  const byType = {};
  for (const d of docs) (byType[d.type] ??= []).push(d);
  const ev = byType.Event?.[0] ?? {};
  const [falcon] = ENVS[entry.env];

  const speakers = (byType.Speaker ?? [])
    .filter((s) => s.isDisplayOnWebsite !== false)
    .map((s) => ({
      id: s.id,
      name: [str(s.firstName), str(s.lastName)].filter(Boolean).join(" ") || str(s.code),
      prefix: str(s.prefix),
      title: str(s.title),
      company: str(s.company),
      designation: str(s.designation),
      bioHtml: textToHtml(s.biography),
      image: url(s.profileImage),
      links: { linkedin: url(s.linkedInProfile), twitter: url(s.twitterProfile), facebook: url(s.facebookProfile) },
      featured: !!s.isFeaturedSpeaker,
      order: s.order ?? 1e9,
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const speakerIds = new Set(speakers.map((s) => s.id));

  const sessions = (byType.Session ?? [])
    .filter((s) => s.displayOnAgenda !== false && !s.restrictSessionVisibility && s.startTime)
    .map((s) => ({
      id: s.id,
      name: str(s.name) || str(s.code),
      start: s.startTime,
      end: s.endTime,
      category: str(s.categoryName),
      room: str(s.locationName),
      descriptionHtml: textToHtml(s.description) || textToHtml(s.richTextDescription),
      speakers: (s.speakers ?? []).filter((id) => speakerIds.has(id)),
      featured: !!s.isFeaturedSession,
      order: s.displayOrder ?? 1e9,
    }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.order - b.order || a.name.localeCompare(b.name));

  const levels = (byType.SponsorshipLevel ?? [])
    .filter((l) => !deleted(l.deleted))
    .map((l) => ({ id: l.id, name: str(l.name), rank: l.rank ?? 1e9 }))
    .sort((a, b) => a.rank - b.rank);

  const exhibitors = (byType.Exhibitor ?? [])
    .filter((x) => !x.hidden && !deleted(x.deleted) && str(x.name))
    .map((x) => ({
      id: x.id,
      name: str(x.name),
      booth: str(x.location),
      website: url(x.websiteUrl),
      descriptionHtml: textToHtml(x.description),
      image: x.profileId
        ? `${falcon}/assets/${entry.id}/exhibitorprofile/${encodeURIComponent(x.profileId)}?environment=${entry.env}&imageSize=200`
        : "",
      level: x.sponsorshipLevelId || x.sponsorshipLevelIds?.[0] || "",
      featured: !!x.featured,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    event: {
      id: entry.id,
      title: str(ev.title) || entry.title || "",
      descriptionHtml: textToHtml(ev.description),
      start: ev.startDate || entry.start,
      end: ev.endDate || entry.end,
      zone: str(ev.zoneId) || "UTC",
      format: str(ev.attendingFormat),
      venue: str(ev.location) || entry.location || "",
      address: [ev.address1, ev.address2, ev.address3].map(str).filter(Boolean),
      city: str(ev.city) || entry.city || "",
      state: str(ev.stateCode) || entry.state || "",
      postalCode: str(ev.postalCode),
      country: str(ev.countryCode) || entry.country || "",
      image: url(entry.image),
    },
    sessions,
    speakers,
    exhibitors,
    levels,
  };
}
