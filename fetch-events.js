#!/usr/bin/env node
/**
 * Collects Sydney events and writes events.js next to this script.
 *
 *   node fetch-events.js              normal run
 *   node fetch-events.js --inspect    show what each strategy found
 *
 * Sources:
 *   1. Ticketmaster Discovery API (needs TM_KEY, optional)
 *   2. City of Sydney What's On — every region and category page,
 *      discovered from the homepage rather than hardcoded.
 *
 * Requires Node 18+ (uses built-in fetch).
 */

const fs = require("fs");
const path = require("path");

const TM_KEY = process.env.TM_KEY || "";
const DAYS_AHEAD = 90;
const INSPECT = process.argv.includes("--inspect");

const COS = "https://whatson.cityofsydney.nsw.gov.au";
const UA = "sydney-events-personal-project/2.0";
const POLITE_DELAY = 1000; // ms between requests to the council site

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- small helpers

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  return res;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function parseWhen(value) {
  if (!value) return null;
  if (typeof value === "object") {
    value = pick(value, ["startDate", "start", "datetime", "date", "from"]);
    if (!value) return null;
  }
  const d = new Date(value);
  if (isNaN(d)) return null;
  const str = String(value);
  const time = str.includes("T") && !str.endsWith("T00:00:00")
    ? d.toTimeString().slice(0, 5)
    : "";
  return { date: isoDate(d), time };
}

function titleCase(slug) {
  return slug
    .split("-")
    .map((w) => (w === "and" ? "&" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// -------------------------------------------------- discovering what to crawl

/** Pulls every /regions/<slug> and /categories/<slug> link out of a page. */
function findSectionSlugs(html, kind) {
  const re = new RegExp(
    'href="(?:https://whatson\\.cityofsydney\\.nsw\\.gov\\.au)?/' + kind + '/([a-z0-9-]+)"',
    "g"
  );
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  return Array.from(found);
}

function findEventSlugs(html) {
  const re =
    /href="(?:https:\/\/whatson\.cityofsydney\.nsw\.gov\.au)?\/events\/([a-z0-9-]+)"/g;
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  return Array.from(found);
}

// ------------------------------------------------------- parsing strategies

/** Strategy A: Next.js embeds page data as JSON in a script tag. */
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

/** Strategy B: schema.org Event blocks — a public standard, very stable. */
function extractJsonLd(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      /* skip malformed block */
    }
  }
  return blocks;
}

/** Finds schema.org Event objects anywhere in a JSON-LD blob. */
function findLdEvents(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => findLdEvents(n, out, depth + 1));
    return out;
  }
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && t.includes("Event"))) {
    out.push(node);
  }
  Object.values(node).forEach((v) => findLdEvents(v, out, depth + 1));
  return out;
}

/** Walks any JSON tree collecting objects that look like events. */
function harvestEvents(node, found = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return found;
  if (seen.has(node)) return found;
  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach((n) => harvestEvents(n, found, seen, depth + 1));
    return found;
  }

  const slug = pick(node, ["slug", "urlSlug", "path"]);
  const name = pick(node, ["name", "title", "eventName", "heading"]);
  if (typeof slug === "string" && typeof name === "string" && name.length > 1) {
    found.push(node);
  }

  Object.values(node).forEach((v) => harvestEvents(v, found, seen, depth + 1));
  return found;
}

// ------------------------------------------------------------- normalisation

function fixUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return COS + u;
  return u;
}

function fromNextData(raw, category) {
  const name = pick(raw, ["name", "title", "eventName", "heading"]);
  const slug = pick(raw, ["slug", "urlSlug", "path"]);

  const when =
    parseWhen(pick(raw, ["startDate", "start", "startsAt", "datetime"])) ||
    parseWhen(raw.sessions && raw.sessions[0]) ||
    parseWhen(raw.nextSession) ||
    parseWhen(raw.dates && raw.dates[0]);

  if (!when) return null;

  const venue =
    pick(raw.venue || {}, ["name", "title"]) ||
    pick(raw, ["venueName", "locationName", "suburb"]) ||
    "See listing";

  const image =
    pick(raw.image || raw.heroImage || {}, ["url", "src"]) ||
    pick(raw, ["imageUrl", "thumbnail"]) ||
    "";

  return {
    name: String(name).trim(),
    date: when.date,
    time: when.time,
    venue: String(venue).trim(),
    category,
    url: COS + "/events/" + String(slug).replace(/^\/?(events\/)?/, ""),
    image: fixUrl(String(image)),
    source: "City of Sydney"
  };
}

function fromJsonLd(ev, slug, category) {
  const when = parseWhen(ev.startDate);
  if (!when || !ev.name) return null;

  let venue = "See listing";
  if (ev.location) {
    venue =
      pick(ev.location, ["name"]) ||
      pick(ev.location.address || {}, ["addressLocality", "streetAddress"]) ||
      venue;
  }

  let image = "";
  if (typeof ev.image === "string") image = ev.image;
  else if (Array.isArray(ev.image)) image = ev.image[0];
  else if (ev.image && ev.image.url) image = ev.image.url;

  return {
    name: String(ev.name).trim(),
    date: when.date,
    time: when.time,
    venue: String(venue).trim(),
    category,
    url: ev.url || COS + "/events/" + slug,
    image: fixUrl(String(image || "")),
    source: "City of Sydney"
  };
}

// ------------------------------------------------------ source: Ticketmaster

async function ticketmaster(start, end) {
  if (!TM_KEY) {
    console.log("  no TM_KEY set, skipping");
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
      startDateTime: start.toISOString().split(".")[0] + "Z",
      endDateTime: end.toISOString().split(".")[0] + "Z"
    });

    const res = await get(
      "https://app.ticketmaster.com/discovery/v2/events.json?" + params
    );
    const data = await res.json();
    const events = (data._embedded && data._embedded.events) || [];
    if (!events.length) break;

    events.forEach((e) => {
      const img = (e.images || [])
        .filter((i) => i.width >= 300)
        .sort((a, b) => a.width - b.width)[0];

      out.push({
        name: e.name,
        date: (e.dates && e.dates.start && e.dates.start.localDate) || "",
        time: (e.dates && e.dates.start && e.dates.start.localTime || "").slice(0, 5),
        venue:
          (e._embedded && e._embedded.venues && e._embedded.venues[0].name) ||
          "Venue TBA",
        category:
          (e.classifications && e.classifications[0].segment.name) || "Other",
        url: e.url,
        image: (img && img.url) || "",
        source: "Ticketmaster"
      });
    });

    if (events.length < 199) break;
    await sleep(300);
  }

  return out;
}

// --------------------------------------------------- source: City of Sydney

async function cityOfSydney() {
  const out = [];
  const seenSlugs = new Set();

  // Discover which pages exist instead of hardcoding a guess.
  console.log("  discovering sections from homepage...");
  let regions = [];
  let categories = [];

  try {
    const home = await (await get(COS + "/")).text();
    regions = findSectionSlugs(home, "regions");
    categories = findSectionSlugs(home, "categories");
  } catch (err) {
    console.log("  couldn't read homepage: " + err.message);
    return out;
  }

  console.log(
    "  found " + regions.length + " regions, " + categories.length + " categories"
  );

  const pages = [
    ...regions.map((s) => ({ url: COS + "/regions/" + s, label: null })),
    ...categories.map((s) => ({ url: COS + "/categories/" + s, label: titleCase(s) }))
  ];

  let viaNextData = 0;
  let needDetail = new Map(); // slug -> category label

  for (const page of pages) {
    await sleep(POLITE_DELAY);

    let html;
    try {
      html = await (await get(page.url)).text();
    } catch (err) {
      console.log("  " + page.url + " — " + err.message);
      continue;
    }

    let kept = 0;

    // Strategy A: the page's own embedded JSON.
    const next = extractNextData(html);
    if (next) {
      const candidates = harvestEvents(next);

      if (INSPECT && candidates.length) {
        console.log("\n  --- sample object from " + page.url);
        console.log("  keys: " + Object.keys(candidates[0]).join(", "));
        console.log(JSON.stringify(candidates[0], null, 1).slice(0, 900) + "\n");
      }

      candidates.forEach((raw) => {
        const ev = fromNextData(raw, page.label || "Other");
        if (ev && !seenSlugs.has(ev.url)) {
          seenSlugs.add(ev.url);
          out.push(ev);
          kept++;
          viaNextData++;
        }
      });
    }

    // Strategy B: if that found nothing, note the event pages to visit directly.
    if (!kept) {
      findEventSlugs(html).forEach((slug) => {
        if (!needDetail.has(slug)) needDetail.set(slug, page.label || "Other");
      });
    }

    console.log("  " + page.url.replace(COS, "") + " — " + kept);
  }

  // Fall back to reading individual event pages for their schema.org data.
  if (needDetail.size) {
    const limit = 250;
    const slugs = Array.from(needDetail.keys()).slice(0, limit);
    console.log(
      "\n  embedded JSON gave " + viaNextData + " events; " +
      "reading " + slugs.length + " event pages directly"
    );

    let viaLd = 0;

    for (const slug of slugs) {
      await sleep(POLITE_DELAY);

      try {
        const html = await (await get(COS + "/events/" + slug)).text();
        const blocks = extractJsonLd(html);
        const events = blocks.flatMap((b) => findLdEvents(b));

        if (INSPECT && viaLd === 0 && events.length) {
          console.log("\n  --- sample schema.org event");
          console.log(JSON.stringify(events[0], null, 1).slice(0, 900) + "\n");
        }

        events.forEach((ev) => {
          const norm = fromJsonLd(ev, slug, needDetail.get(slug));
          if (norm && !seenSlugs.has(norm.url)) {
            seenSlugs.add(norm.url);
            out.push(norm);
            viaLd++;
          }
        });
      } catch (err) {
        /* one bad page shouldn't stop the run */
      }
    }

    console.log("  got " + viaLd + " events from event pages");
  }

  return out;
}

// -------------------------------------------------------------------- main

function dedupe(events) {
  const seen = new Map();
  events.forEach((e) => {
    const key = e.name.toLowerCase().replace(/\W/g, "") + "|" + e.date;
    if (!seen.has(key)) seen.set(key, e);
  });
  return Array.from(seen.values());
}

async function main() {
  const now = new Date();
  const end = new Date(Date.now() + DAYS_AHEAD * 86400000);
  const today = isoDate(now);
  const cutoff = isoDate(end);

  console.log("Collecting Sydney events, " + today + " to " + cutoff + "\n");

  console.log("Ticketmaster:");
  const tm = await ticketmaster(now, end).catch((e) => {
    console.log("  failed: " + e.message);
    return [];
  });
  console.log("  " + tm.length + " events\n");

  console.log("City of Sydney:");
  const cos = await cityOfSydney().catch((e) => {
    console.log("  failed: " + e.message);
    return [];
  });
  console.log("  " + cos.length + " events\n");

  const all = dedupe(tm.concat(cos))
    .filter((e) => e.date >= today && e.date <= cutoff)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  fs.writeFileSync(
    path.join(__dirname, "events.js"),
    "window.EVENT_DATA = " +
      JSON.stringify({ generated: new Date().toISOString(), events: all }, null, 1) +
      ";\n"
  );

  const bySource = {};
  const byCat = {};
  all.forEach((e) => {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    byCat[e.category] = (byCat[e.category] || 0) + 1;
  });

  console.log("Wrote events.js — " + all.length + " events");
  console.log("By source:", bySource);
  console.log("By category:", byCat);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

module.exports = {
  harvestEvents, fromNextData, fromJsonLd, parseWhen, extractNextData,
  extractJsonLd, findLdEvents, findSectionSlugs, findEventSlugs, dedupe, titleCase
};
