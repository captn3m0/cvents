import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "../../node_modules/@resvg/resvg-wasm/index_bg.wasm";
import BOLD from "../fonts/OpenSans-Bold.subset.ttf";
import REGULAR from "../fonts/OpenSans-Regular.subset.ttf";
import TEMPLATE from "./og.svg";
import { escapeHtml } from "./model.js";
import { dateRange } from "./render.js";

const LOGO_MAX = 1_000_000;
let ready;

const esc = (s) => escapeHtml(s);

// Rough Open Sans advance widths in em, so lines can be fitted to a pixel budget.
const em = (ch, bold) => {
  const w = /[A-Z0-9]/.test(ch) ? 0.68 : ch === " " ? 0.26 : /[ilj.,;:'|!]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.9 : 0.58;
  return bold ? w : w * 0.93;
};
const width = (t, size, bold) => [...t].reduce((n, ch) => n + em(ch, bold) * size, 0);

export function wrap(text, maxPx, maxLines = 4, size = 60, bold = true) {
  const fits = (t) => width(t, size, bold) <= maxPx;
  const lines = [];
  let cur = "";
  for (let w of text.split(/\s+/).filter(Boolean)) {
    while (!fits(w)) {
      let n = w.length - 1;
      while (n > 1 && !fits(`${w.slice(0, n)}-`)) n--;
      if (cur) lines.push(cur);
      [cur, w] = [`${w.slice(0, n)}-`, w.slice(n)];
    }
    if (cur && !fits(`${cur} ${w}`)) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1].replace(/[ ,.;:-]*$/, "");
    while (last.length > 1 && !fits(`${last}…`)) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

async function fetchLogo(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return "";
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > LOGO_MAX) return "";
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch (e) {
    console.error("og image", url, e.message);
    return "";
  }
}

const AV = 44;
const STEP = 64;

// Overlapping circular speaker photos, right-aligned under the logo badge, first speaker on top.
function speakerBadges(speakers) {
  if (!speakers?.count) return "";
  const imgs = speakers.images;
  const label = `<text x="1012" y="560" text-anchor="middle" font-family="Open Sans" font-size="24" fill="#5f5b78">${speakers.count} speaker${speakers.count === 1 ? "" : "s"}</text>`;
  const x0 = 1012 - ((imgs.length - 1) * STEP) / 2;
  const faces = imgs.map((src, i) => {
    const cx = x0 + i * STEP;
    return `<clipPath id="a${i}"><circle cx="${cx}" cy="480" r="${AV}"/></clipPath>`
      + `<circle cx="${cx}" cy="480" r="${AV + 4}" fill="#ffffff"/>`
      + `<image href="${src}" x="${cx - AV}" y="${480 - AV}" width="${AV * 2}" height="${AV * 2}" clip-path="url(#a${i})" preserveAspectRatio="xMidYMid slice"/>`;
  }).reverse().join("");
  return faces + label;
}

export function fillTemplate({ title, dates, place, logo, host, speakers }) {
  const lines = wrap(title, logo ? 790 : 1056);
  const y0 = 230 - (lines.length - 1) * 18;
  const tspans = lines.map((l, i) => `<tspan x="72" y="${y0 + i * 72}">${esc(l)}</tspan>`).join("");
  const badge = logo
    ? `<rect x="896" y="150" width="232" height="232" rx="24" fill="#ffffff" stroke="#d9d0f5" stroke-width="3"/><image href="${logo}" x="912" y="166" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  return TEMPLATE.replace("{{LOGO}}", badge).replace("{{TITLE}}", tspans)
    .replace("{{DATES}}", esc(dates)).replace("{{PLACE}}", esc(wrap(place, speakers?.count ? 770 : 1056, 1, 30, false)[0] || ""))
    .replace("{{SPEAKERS}}", speakerBadges(speakers)).replace("{{HOST}}", esc(host));
}

// speakers: { count, photos: [url] } from live event data, or null when it is unavailable.
export async function renderOg(entry, origin, speakers) {
  ready ??= initWasm(wasm);
  await ready;
  const [logo, ...fetched] = entry ? await Promise.all([fetchLogo(entry.image), ...(speakers?.photos ?? []).map(fetchLogo)]) : [""];
  const images = fetched.filter(Boolean);
  const svg = fillTemplate(entry ? {
    title: entry.title || entry.slug, dates: dateRange(entry.start, entry.end), host: new URL(origin).host,
    place: [entry.location, entry.city, entry.country].filter(Boolean).join(", "), logo,
    speakers: speakers?.count ? { count: speakers.count, images } : null,
  } : {
    title: "Event schedules", dates: "Agendas, speakers and exhibitors", place: "Calendar feeds for every event",
    logo: "", host: new URL(origin).host,
  });
  const png = new Resvg(svg, {
    font: { fontBuffers: [new Uint8Array(REGULAR), new Uint8Array(BOLD)], defaultFontFamily: "Open Sans", loadSystemFonts: false },
  }).render().asPng();
  return png;
}
