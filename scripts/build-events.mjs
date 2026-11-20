// Bundle events/*.yml into worker/src/events.gen.json for the Worker.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DIR = "events";
const OUT = "worker/src/events.gen.json";
const ENVS = new Set(["production", "production-eu"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const events = [];
const slugs = new Map();
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml")).sort()) {
  const e = parse(readFileSync(join(DIR, file), "utf8")) ?? {};
  const fail = (msg) => { throw new Error(`${file}: ${msg}`); };
  if (!UUID.test(e.id ?? "")) fail("id must be a lowercase uuid");
  if (file !== `${e.id}.yml`) fail("file name must be {id}.yml");
  if (!ENVS.has(e.env)) fail(`env must be one of ${[...ENVS]}`);
  if (!SLUG.test(e.slug ?? "")) fail("slug must be lowercase words joined by -");
  if (slugs.has(e.slug)) fail(`slug also used by ${slugs.get(e.slug)}`);
  slugs.set(e.slug, file);
  if (e.hidden === true) continue;
  const pick = ["id", "env", "slug", "title", "start", "end", "location", "city", "state", "country", "image"];
  events.push(Object.fromEntries(pick.filter((k) => e[k] != null).map((k) => [k, String(e[k]).trim()])));
}
events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.slug.localeCompare(b.slug));
writeFileSync(OUT, JSON.stringify(events));
console.log(`wrote ${events.length} events to ${OUT}`);
