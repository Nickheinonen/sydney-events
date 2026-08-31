#!/usr/bin/env node
/**
 * Collects Sydney events from multiple sources and writes events.js
 * next to this script, which index.html loads directly.
 *
 *   node fetch-events.js              normal run
 *   node fetch-events.js --inspect    dump field names from City of Sydney
 *
 * Ticketmaster key: set TM_KEY in your environment, or paste it below.
 * Requires Node 18+ (uses built-in fetch).
 */

const fs = require("fs");
const path = require("path");

const TM_KEY = process.env.TM_KEY || "";
const DAYS_AHEAD = 60;
const INSPECT = process.argv.includes("--inspect");

const UA = "sydney-events-personal-project/1.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Pulls the first present key from an object. */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** Coerces whatever date shape we're handed into YYYY-MM-DD + HH:MM. */
function parseWhen(value) {
  if (!value) return null;
  if (typeof value === "object") {
    value = pick(value, ["startDate", "start", "datetime", "date", "from"]);
    if (!value) return null;
  }
  const d = new Date(value);
  if (isNaN(d)) return null;
  const time =
    String(value).includes("T") && !String(value).endsWith("T00:00:00")
      ? d.toTimeString().slice(0, 5)
      : "";
  return { date: isoDate(d), time };
}

// ---------------------------------------------------------- source one: TM

async function ticketmaster(windowStart, windowEnd) {
  if (!TM_KEY) {
    console.log("  Ticketmaster: no TM_KEY set, skipping");
    return [];
  }

  const out = [];

  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      apikey: TM_KEY,
      city: "Sydney",
      countryCode: "AU",
      size: "199",
      page: String(page),
      sort: "date,asc",
      startDateTime: windowStart.toISOString().split(".")[0] + "Z",
      endDateTime: windowEnd.toISOString().split(".")[0] + "Z"
    });

    const res = await get(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`
    );
    const data = await res.json();
    const events = data._embedded?.events ?? [];
    if (!events.length) break;

    for (const e of events) {
      const image = [...(e.images ?? [])]
        .filter((i) => i.width >= 300)
        .sort((a, b) => a.width - b.width)[0];

      out.push({
        name: e.name,
        date: e.dates?.start?.localDate ?? "",
        time: e.dates?.start?.localTime?.slice(0, 5) ?? "",
        venue: e._embedded?.venues?.[0]?.name ?? "Venue TBA",
        category: e.classifications?.[0]?.segment?.name ?? "Other",
        url: e.url,
        image: image?.url ?? "",
        source: "Ticketmaster"
      });
    }

    if (events.length < 199) break;
    await sleep(300);
  }

  return out;
}

// ------------------------------------------------ source two: City of Sydney

const COS_BASE = "https://whatson.cityofsydney.nsw.gov.au";

const COS_CATEGORIES = [
  "music",
  "nightlife",
  "food-and-drink",
  "shopping-markets-and-fairs",
  "exhibitions",
  "theatre-dance-and-film",
  "talks-courses-and-workshops",
  "sport-and-fitness",
  "tours-and-experiences",
  "children-and-family"
];

/** Next.js embeds page data as JSON in a script tag. Far sturdier than tag scraping. */
function extractNextData(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Walks the JSON tree collecting anything shaped like an event.
 * Written defensively — the site can reorganise its data without
 * this breaking, as long as the objects themselves keep their shape.
 */
function harvestEvents(node, found = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return found;
  if (seen.has(node)) return found;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) harvestEvents(item, found, seen, depth + 1);
    return found;
  }

  const slug = pick(node, ["slug", "urlSlug", "path"]);
  const name = pick(node, ["name", "title", "eventName", "heading"]);

  if (typeof slug === "string" && typeof name === "string" && name.length > 1) {
    found.push(node);
  }

  for (const value of Object.values(node)) {
    harvestEvents(value, found, seen, depth + 1);
  }

  return found;
}

function normaliseCosEvent(raw, category) {
  const name = pick(raw, ["name", "title", "eventName", "heading"]);
  const slug = pick(raw, ["slug", "urlSlug", "path"]);

  const when =
    parseWhen(pick(raw, ["startDate", "start", "startsAt", "datetime"])) ??
    parseWhen(raw.sessions?.[0]) ??
    parseWhen(raw.nextSession) ??
    parseWhen(raw.dates?.[0]);

  if (!when) return null;

  const venue =
    pick(raw.venue ?? {}, ["name", "title"]) ??
    pick(raw, ["venueName", "locationName", "suburb"]) ??
    "See listing";

  const image =
    pick(raw.image ?? raw.heroImage ?? {}, ["url", "src"]) ??
    pick(raw, ["imageUrl", "thumbnail"]) ??
    "";

  return {
    name: String(name).trim(),
    date: when.date,
    time: when.time,
    venue: String(venue).trim(),
    category,
    url: String(slug).startsWith("http")
      ? slug
      : `${COS_BASE}/events/${String(slug).replace(/^\/?(events\/)?/, "")}`,
    image: image.startsWith("//") ? `https:${image}` : image,
    source: "City of Sydney"
  };
}

const COS_LABELS = {
  "music": "Music",
  "nightlife": "Nightlife",
  "food-and-drink": "Food & Drink",
  "shopping-markets-and-fairs": "Markets",
  "exhibitions": "Exhibitions",
  "theatre-dance-and-film": "Arts & Theatre",
  "talks-courses-and-workshops": "Talks & Workshops",
  "sport-and-fitness": "Sports",
  "tours-and-experiences": "Tours",
  "children-and-family": "Family"
};

async function cityOfSydney() {
  const out = [];

  for (const cat of COS_CATEGORIES) {
    try {
      const res = await get(`${COS_BASE}/categories/${cat}`);
      const html = await res.text();
      const data = extractNextData(html);

      if (!data) {
        console.log(`  ${cat}: no __NEXT_DATA__ found`);
        await sleep(1000);
        continue;
      }

      const candidates = harvestEvents(data);

      if (INSPECT && candidates.length) {
        console.log(`\n--- ${cat}: ${candidates.length} candidates`);
        console.log("Sample object keys:", Object.keys(candidates[0]));
        console.log(JSON.stringify(candidates[0], null, 2).slice(0, 1200));
      }

      let kept = 0;
      for (const raw of candidates) {
        const ev = normaliseCosEvent(raw, COS_LABELS[cat] ?? "Other");
        if (ev) {
          out.push(ev);
          kept++;
        }
      }

      console.log(`  ${cat}: ${kept} events (${candidates.length} candidates)`);
    } catch (err) {
      console.log(`  ${cat}: ${err.message}`);
    }

    await sleep(1000); // one request per second, be a good citizen
  }

  return out;
}

// ------------------------------------------------------------------- main

function dedupe(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.name.toLowerCase().replace(/\W/g, "")}|${e.date}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

async function main() {
  const now = new Date();
  const end = new Date(Date.now() + DAYS_AHEAD * 86400000);
  const today = isoDate(now);
  const cutoff = isoDate(end);

  console.log(`Collecting Sydney events, ${today} to ${cutoff}\n`);

  console.log("Ticketmaster:");
  const tm = await ticketmaster(now, end).catch((e) => {
    console.log(`  failed: ${e.message}`);
    return [];
  });
  console.log(`  ${tm.length} events\n`);

  console.log("City of Sydney:");
  const cos = await cityOfSydney();
  console.log(`  ${cos.length} events total\n`);

  const all = dedupe([...tm, ...cos])
    .filter((e) => e.date >= today && e.date <= cutoff)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const payload = {
    generated: new Date().toISOString(),
    events: all
  };

  fs.writeFileSync(
    path.join(__dirname, "events.js"),
    `window.EVENT_DATA = ${JSON.stringify(payload, null, 1)};\n`
  );

  const bySource = {};
  for (const e of all) bySource[e.source] = (bySource[e.source] ?? 0) + 1;

  console.log(`Wrote events.js — ${all.length} events`);
  console.log(bySource);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

module.exports = { harvestEvents, normaliseCosEvent, parseWhen, extractNextData, dedupe };
