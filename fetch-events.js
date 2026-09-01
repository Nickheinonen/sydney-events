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

/**
 * Image fields come in many shapes: a bare string, an array, {url}, {src},
 * or Contentful's nested {fields:{file:{url}}}. Try them all.
 */
function pickImage(node, depth = 0) {
  if (!node || depth > 4) return "";

  if (typeof node === "string") {
    return /^(https?:)?\/\//.test(node) || node.startsWith("/") ? node : "";
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickImage(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof node !== "object") return "";

  // Contentful and similar nested asset shapes
  const nested =
    (node.fields && node.fields.file) ||
    node.file ||
    node.asset ||
    node.image ||
    node.heroImage ||
    node.featuredImage ||
    node.listingImage ||
    node.thumbnail ||
    node.media;

  const direct = node.secure_url || node.url || node.src || node.imageUrl;
  if (typeof direct === "string") {
    const found = pickImage(direct, depth + 1);
    if (found) return found;
  }

  return nested ? pickImage(nested, depth + 1) : "";
}

/** Ask Contentful for a sensibly sized image instead of the full original. */
function sizeImage(url) {
  if (!url) return url;

  // Cloudinary takes transformations in the path, after /upload/
  if (url.indexOf("res.cloudinary.com") !== -1 && url.indexOf("/upload/w_") === -1) {
    return url.replace("/upload/", "/upload/w_600,f_auto,q_auto/");
  }

  if (url.indexOf("ctfassets.net") !== -1 && url.indexOf("?") === -1) {
    return url + "?w=600&fm=jpg&q=75";
  }

  return url;
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
    pickImage(raw.tileImageCloudinary) ||
    pickImage(raw.heroImageCloudinary) ||
    pickImage(raw.imageCloudinary) ||
    pickImage(raw.image) ||
    pickImage(raw.heroImage) ||
    pickImage(raw.featuredImage) ||
    pickImage(raw.listingImage) ||
    pickImage(raw.thumbnail) ||
    pickImage(raw.imageUrl) ||
    pickImage(raw.media) ||
    pickImage(raw.images) ||
    "";

  return {
    name: String(name).trim(),
    date: when.date,
    time: when.time,
    venue: String(venue).trim(),
    category,
    url: COS + "/events/" + String(slug).replace(/^\/?(events\/)?/, ""),
    image: sizeImage(fixUrl(String(image))),
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

  const image = pickImage(ev.image) || pickImage(ev.thumbnailUrl);

  return {
    name: String(ev.name).trim(),
    date: when.date,
    time: when.time,
    venue: String(venue).trim(),
    category,
    url: ev.url || COS + "/events/" + slug,
    image: sizeImage(fixUrl(String(image || ""))),
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

/**
 * The listing pages keep their events at a known path. Use it when present —
 * the generic walker also picks up categories and venues, which are noise.
 */
function findEventHits(next) {
  const hits = next && next.props && next.props.pageProps &&
               next.props.pageProps.events && next.props.pageProps.events.hits;
  return Array.isArray(hits) && hits.length ? hits : null;
}

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
      const candidates = findEventHits(next) || harvestEvents(next);


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

// ---------------------------------------------------------- source: Moshtix
// Moshtix run an open GraphQL API allowing anonymous queries for public
// events: https://developer.moshtix.com/docs/our-api
// Ticketmaster owns Moshtix and carries some of its events, but not all —
// dedupe by name and date sorts out the overlap.

const MOSHTIX_API = "https://api.moshtix.com/v1/graphql";
const MOSHTIX_MAX_PAGES = 80;

const SYDNEY = new Set([
  "sydney","haymarket","ultimo","pyrmont","chippendale","glebe","redfern",
  "surry hills","darlinghurst","potts point","kings cross","woolloomooloo",
  "paddington","woollahra","alexandria","waterloo","zetland","rosebery",
  "erskineville","newtown","enmore","camperdown","annandale","stanmore",
  "petersham","lewisham","summer hill","ashfield","croydon","burwood",
  "strathfield","homebush","sydney olympic park","marrickville","sydenham",
  "st peters","dulwich hill","leichhardt","lilyfield","rozelle","balmain",
  "drummoyne","five dock","concord","north sydney","crows nest","kirribilli",
  "st leonards","chatswood","manly","brookvale","dee why","mosman",
  "neutral bay","bondi","bondi junction","bondi beach","coogee","randwick",
  "kensington","kingsford","maroubra","mascot","botany","moore park",
  "double bay","rushcutters bay","parramatta","granville","auburn",
  "blacktown","penrith","liverpool","bankstown","hurstville","kogarah",
  "rockdale","cronulla","miranda","caringbah","sutherland","campbelltown",
  "camden","ryde","gladesville","epping","hornsby","castle hill",
  "rouse hill","the rocks","barangaroo","darling harbour","millers point",
  "walsh bay","eveleigh","alexandria","banksmeadow","st leonards"
]);

/**
 * Moshtix's date format isn't documented publicly, so handle the plausible
 * shapes: epoch seconds, epoch milliseconds, or ISO with or without a zone.
 */
function parseMoshtixDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value).trim();

  // "2026-09-13T19:30:00" with no zone means wall-clock time at the venue.
  const bare = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (bare && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(str)) {
    return { date: bare[1], time: bare[2] === "00:00" ? "" : bare[2] };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return { date: str, time: "" };

  let d;
  if (typeof value === "number" || /^\d+$/.test(str)) {
    let n = Number(value);
    if (n < 1e11) n *= 1000;          // seconds, not milliseconds
    d = new Date(n);
  } else {
    d = new Date(value);
  }

  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  if (year < 1990 || year > 2100) return null;   // 1970 means an epoch misparse

  const date = d.toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
  const time = d.toLocaleTimeString("en-GB", {
    timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit"
  });
  return { date: date, time: time === "00:00" ? "" : time };
}

/** Moshtix's own slug rule, from their documentation. */
function moshtixSlug(name) {
  if (!name) return "";
  return name.trim().toLowerCase()
    .replace(/([^0-9a-zA-Z-\u4e00-\u9eff])+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * getEvents supports eventStartDateFrom / eventStartDateTo, so we ask for the
 * window directly rather than paging through their whole history.
 * Schema: https://github.com/moshtix/graphql-api-definition
 */
function moshtixPage(pageIndex, pageSize, fromIso, toIso) {
  const dateArgs = fromIso
    ? ', eventStartDateFrom: "' + fromIso + 'T00:00:00.000Z"' +
      ', eventStartDateTo: "' + toIso + 'T23:59:59.000Z"'
    : "";

  return "query { viewer { getEvents(pageIndex: " + pageIndex +
    ", pageSize: " + pageSize + ", sortBy: STARTDATE, sortByDirection: ASC" +
    dateArgs + ") { totalCount pageInfo { hasNextPage } items { id name startDate " +
    "venue { name imageUrl address { locality } } genre { name } " +
    "images { items { url type } } } } } }";
}

async function moshtixQuery(query) {
  const res = await fetch(MOSHTIX_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query: query })
  });
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

function moshtixImage(ev) {
  const fromEvent = pickImage(ev.images && ev.images.items);
  if (fromEvent) return fromEvent;
  return pickImage(ev.venue && ev.venue.imageUrl) || "";
}

async function moshtix(todayIso, cutoffIso) {
  const out = [];
  let pageSize = 100;
  let pageIndex = 0;
  let scanned = 0;
  let unparsed = 0;
  let useDates = true;      // drop to false if the API rejects the date args
  let hitCap = false;

  while (true) {
    if (pageIndex >= MOSHTIX_MAX_PAGES) { hitCap = true; break; }

    let data;
    try {
      data = await moshtixQuery(
        useDates
          ? moshtixPage(pageIndex, pageSize, todayIso, cutoffIso)
          : moshtixPage(pageIndex, pageSize)
      );
    } catch (err) {
      if (useDates && pageIndex === 0) {
        console.log("  date filtering rejected (" + err.message + "), falling back");
        useDates = false;
        continue;
      }
      if (pageSize > 25) {
        console.log("  pageSize " + pageSize + " rejected, retrying at 25");
        pageSize = 25;
        continue;
      }
      console.log("  failed on page " + pageIndex + ": " + err.message);
      break;
    }

    const conn = data && data.viewer && data.viewer.getEvents;
    if (!conn || !conn.items || !conn.items.length) break;

    if (pageIndex === 0) {
      console.log("  " + (useDates ? "date-filtered" : "unfiltered") +
        ", totalCount " + conn.totalCount);
    }

    let pastCutoff = false;

    for (const ev of conn.items) {
      scanned++;
      const when = parseMoshtixDate(ev.startDate);
      if (!when) { unparsed++; continue; }

      if (when.date > cutoffIso) { pastCutoff = true; continue; }
      if (when.date < todayIso) continue;

      const locality = ev.venue && ev.venue.address && ev.venue.address.locality;
      if (!locality || !SYDNEY.has(String(locality).trim().toLowerCase())) continue;

      out.push({
        name: String(ev.name).trim(),
        date: when.date,
        time: when.time,
        venue: (ev.venue && ev.venue.name) ? String(ev.venue.name).trim() : String(locality),
        category: (ev.genre && ev.genre.name) ? String(ev.genre.name).trim() : "Music",
        url: "https://www.moshtix.com.au/v2/event/" + moshtixSlug(ev.name) + "/" + ev.id,
        image: sizeImage(fixUrl(moshtixImage(ev))),
        source: "Moshtix"
      });
    }

    if (pastCutoff) break;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;

    pageIndex++;
    await sleep(500);
  }

  if (unparsed) console.log("  WARNING: " + unparsed + " unreadable dates");
  if (hitCap) console.log("  WARNING: hit the " + MOSHTIX_MAX_PAGES + " page cap");
  console.log("  scanned " + scanned + " events, kept " + out.length + " in Sydney");
  return out;
}

// ------------------------------------------------------ category consolidation
// Three sources use three vocabularies, and Moshtix reports music genres.
// Collapse them onto a fixed set of shelves.

const CATEGORY_MAP = {
  // music, kept in a few sized shelves rather than one huge one
  "music": "Live Music",
  "festivals": "Live Music",
  "rock / pop": "Rock & Indie",
  "indie": "Rock & Indie",
  "hard rock / metal": "Rock & Indie",
  "punk": "Rock & Indie",
  "acoustic": "Rock & Indie",
  "electronic / dance": "Nightlife & Electronic",
  "soul / rnb": "Soul, Jazz & Global",
  "jazz": "Soul, Jazz & Global",
  "blues / roots": "Soul, Jazz & Global",
  "hip hop": "Soul, Jazz & Global",
  "reggae": "Soul, Jazz & Global",
  "world / latin": "Soul, Jazz & Global",
  "country": "Soul, Jazz & Global",

  "nightlife": "Nightlife & Electronic",
  "comedy": "Comedy",

  "theatre dance & film": "Stage & Screen",
  "theatre, dance & film": "Stage & Screen",
  "arts & theatre": "Stage & Screen",
  "theatre": "Stage & Screen",

  "exhibitions": "Exhibitions",
  "fashion": "Exhibitions",

  "food & drink": "Food & Drink",
  "shopping markets & fairs": "Markets & Festivals",

  "talks courses & workshops": "Learn & Do",
  "talks, courses & workshops": "Learn & Do",
  "educational / pd / workshop": "Learn & Do",
  "tours & experiences": "Learn & Do",

  "sport & fitness": "Fitness",
  "sports": "Sport",

  "children & family": "Family",
  "all ages": "Family",

  "community & causes": "Community",

  "miscellaneous": "Other",
  "other": "Other"
};

/** Shelf order on the page — most useful first, Other last. */
// Deliberately interleaved so the top of the page isn't five music shelves
// in a row. Music is the biggest category but shouldn't dominate browsing.
const SHELF_ORDER = [
  "Rock & Indie",
  "Comedy",
  "Nightlife & Electronic",
  "Stage & Screen",
  "Food & Drink",
  "Soul, Jazz & Global",
  "Markets & Festivals",
  "Exhibitions",
  "Learn & Do",
  "Classical & Opera",
  "Fitness",
  "Family",
  "Sport",
  "Community",
  "Other Music",
  "Other"
];

function consolidateCategory(raw) {
  const key = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  return CATEGORY_MAP[key] || null;      // null means we've not seen it before
}

// ------------------------------------------------- nightlife reclassification
// Ticketmaster has no nightlife segment, so club nights arrive labelled
// "Music". Move the clear cases across.

// Venues where essentially everything on is a club night.
const CLUB_VENUES = [
  "chinese laundry", "civic underground", "home nightclub", "marquee",
  "club 77", "burdekin", "the burdekin", "kings cross hotel", "world bar",
  "goros", "tokyo sing song", "the cliff dive", "sly fox", "freda's",
  "the bearded tit", "since i left you", "greenwood hotel", "ivy"
];

// Live venues: nightlife only with a late start or an explicit signal.
const LIVE_VENUES = [
  "oxford art factory", "the lansdowne", "lansdowne hotel", "enmore theatre",
  "metro theatre", "the metro", "factory theatre", "camelot lounge",
  "the vanguard", "manning bar", "the chippo", "chippo hotel",
  "marlborough hotel", "the marly", "waywards", "crowbar", "the golden age",
  "phoenix central park", "liberty hall", "the great club", "django",
  "the red rattler", "the bank hotel", "york hotel", "hotel hollywood"
];

const NIGHTLIFE_WORDS = /\b(djs?|b2b|back to back|techno|house music|drum ?(and|&|n) ?bass|dnb|rave|club ?night|disco|warehouse party|after ?party|afters|nightclub|selectors|boiler room|all ?nighter|dance ?floor|til+ late|dusk ?til|late ?night session)\b/i;

// Words that look like nightlife but aren't.
const NOT_NIGHTLIFE = /\b(trivia|quiz|opening night|closing night|family|kids|children|matinee|workshop|market|breakfast|brunch|morning|storytime|school holiday|toddler|seniors|book club)\b/i;

function matchesVenue(venue, list) {
  const v = String(venue).toLowerCase();
  return list.some((name) => v.indexOf(name) !== -1);
}

/** Only reclassify things already in a music-ish bucket — never a workshop. */
function eligibleForNightlife(category) {
  const c = String(category).toLowerCase();
  return c === "live music" || c === "rock & indie" ||
         c === "soul, jazz & global" || c === "nightlife & electronic" ||
         c === "other";
}

function isNightlife(ev) {
  if (!eligibleForNightlife(ev.category)) return false;
  if (NOT_NIGHTLIFE.test(ev.name)) return false;

  if (NIGHTLIFE_WORDS.test(ev.name)) return true;
  if (matchesVenue(ev.venue, CLUB_VENUES)) return true;

  const startsLate = ev.time && ev.time >= "20:00";
  if (startsLate && matchesVenue(ev.venue, LIVE_VENUES)) return true;

  return false;
}

// -------------------------------------------------- comedy reclassification
// Ticketmaster files comedy under "Arts & Theatre" and the council under
// "Theatre Dance & Film", so it has to be recovered from the event name.

const COMEDY_WORDS = /\b(comedy|comedian|comedians|stand[- ]?up|improv|improvised|sketch show|roast(ed)?|open mic|laughs|gag show|panel show)\b/i;

// Titles that mention comedy but are plays, films or musicals.
const NOT_COMEDY = /\b(comedy of errors|musical comedy|romantic comedy|dark comedy|comedy drama|divine comedy)\b/i;

// Rooms that do comedy and essentially nothing else.
const COMEDY_VENUES = [
  "comedy store", "comedy lounge", "comedy bar", "comedy club",
  "the comics lounge", "factory theatre comedy"
];

function eligibleForComedy(category) {
  const c = String(category).toLowerCase();
  return c === "stage & screen" || c === "other" ||
         c === "nightlife & electronic" || c === "live music";
}

function isComedy(ev) {
  if (!eligibleForComedy(ev.category)) return false;
  if (NOT_COMEDY.test(ev.name)) return false;
  if (COMEDY_WORDS.test(ev.name)) return true;
  if (matchesVenue(ev.venue, COMEDY_VENUES)) return true;
  return false;
}

// ------------------------------------------------------------ music refining
// "Live Music" is just events whose source gave no genre. Classify what we
// can from the title and venue; whatever resists becomes "Other Music".

const GENRE_RULES = [
  {
    shelf: "Classical & Opera",
    // "Opera Bar" and "rock opera" are not opera.
    not: /\b(opera bar|opera quays|opera kitchen|soap opera|rock opera|space opera|opera house forecourt)\b/i,
    words: /\b(orchestra|orchestral|symphony|symphonic|philharmonic|oper(a|atic)|concerto|chamber music|chamber orchestra|string quartet|recital|choir|choral|cantata|requiem|baroque|sonata|mozart|beethoven|bach|chopin|vivaldi|tchaikovsky|handel|verdi|puccini|brahms|schubert)\b/i,
    venues: ["city recital hall", "angel place", "utzon room", "verbrugghen",
             "sydney conservatorium", "concert hall"]
  },
  {
    shelf: "Nightlife & Electronic",
    words: /\b(electronic|electronica|techno|house music|trance|edm|dubstep|drum ?(and|&|n) ?bass|synth ?wave|ambient|breakbeat|garage house)\b/i,
    venues: []
  },
  {
    shelf: "Soul, Jazz & Global",
    words: /\b(jazz|blues|soul|funk|reggae|ska|dub|folk|bluegrass|country|americana|gospel|r&b|rnb|latin|salsa|cumbia|afrobeat|world music|roots|swing|bossa|motown|doo ?wop)\b/i,
    venues: ["camelot lounge", "foundry616", "the vanguard", "django", "venue 505",
             "the basement", "birdland"]
  },
  {
    shelf: "Rock & Indie",
    words: /\b(rock|punk|metal|indie|hardcore|grunge|emo|shoegaze|garage|alternative|psych|post[- ]punk|tribute|covers band)\b/i,
    venues: ["crowbar", "bald faced stag", "manning bar", "the lansdowne",
             "the marly", "hotel hollywood", "the bridge hotel"]
  }
];

/** Returns a genre shelf for an ungenred music event, or null if unclear. */
function refineMusic(ev) {
  for (const rule of GENRE_RULES) {
    if (rule.not && rule.not.test(ev.name)) continue;
    if (rule.words.test(ev.name)) return rule.shelf;
    if (rule.venues.length && matchesVenue(ev.venue, rule.venues)) return rule.shelf;
  }
  return null;
}

// -------------------------------------------------- sport vs fitness
// Watching a game and doing exercise are different intents. Source
// categories don't reliably separate them, so check the title too.

const SPECTATOR = /\b(vs\.?|versus|match|fixture|grand final|semi[- ]final|test match|derby|round \d+|nrl|afl|a[- ]league|w[- ]league|super rugby|shield|cup final|championship|title fight|race day|raceday|grand prix)\b/i;

const PARTICIPATORY = /\b(class|classes|session|workshop|yoga|pilates|tai chi|qigong|bootcamp|boot camp|parkrun|park run|fun run|walk|walking|hike|swim|swimming|cycle|cycling|zumba|barre|stretch|meditation|dance fit|learn to|beginners|come and try|social sport)\b/i;

/** Returns "Sport", "Fitness", or null to leave the mapped value alone. */
function refineActive(ev) {
  if (ev.category !== "Sport" && ev.category !== "Fitness") return null;
  if (SPECTATOR.test(ev.name)) return "Sport";
  if (PARTICIPATORY.test(ev.name)) return "Fitness";
  return null;
}

// --------------------------------------------- markets and festivals sweep
// Markets and general festivals are scattered across the community, family
// and food shelves. Gather them — but leave genre festivals where they are,
// since a film festival is still film and a music festival is still music.

const MARKET_WORDS = /\b(markets?|fair|fayre|fete|bazaar|car boot|flea market|farmers?'? ?market|night market|craft market|makers market)\b/i;

const FESTIVAL_WORDS = /\b(festival|fiesta|carnival|street party|block party|street feast)\b/i;

// Festivals that belong to a genre shelf rather than here.
const GENRE_FESTIVAL = /\b(film|music|comedy|writers?|literary|jazz|opera|dance|theatre|art) festival\b/i;

/** Shelves general enough that a market or festival is better filed here. */
function eligibleForMarkets(category) {
  const c = String(category).toLowerCase();
  return c === "food & drink" || c === "community" || c === "family" ||
         c === "learn & do" || c === "other";
}

function isMarketOrFestival(ev) {
  if (!eligibleForMarkets(ev.category)) return false;
  if (GENRE_FESTIVAL.test(ev.name)) return false;
  return MARKET_WORDS.test(ev.name) || FESTIVAL_WORDS.test(ev.name);
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

  console.log("Moshtix:");
  const mox = await moshtix(today, cutoff).catch((e) => {
    console.log("  failed: " + e.message);
    return [];
  });
  console.log("  " + mox.length + " events\n");

  // Ticketmaster first, so its richer records win any duplicate.
  const all = dedupe(tm.concat(cos).concat(mox))
    .filter((e) => e.date >= today && e.date <= cutoff)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const unmapped = {};
  all.forEach((e) => {
    const shelf = consolidateCategory(e.category);
    if (shelf) {
      e.category = shelf;
    } else {
      unmapped[e.category] = (unmapped[e.category] || 0) + 1;
      e.category = "Other";
    }
  });
  if (Object.keys(unmapped).length) {
    console.log("Categories I did not recognise (filed as Other):", unmapped);
  }

  let reclassified = 0;
  all.forEach((e) => {
    if (e.category !== "Nightlife & Electronic" && isNightlife(e)) {
      e.category = "Nightlife & Electronic";
      reclassified++;
    }
  });
  if (reclassified) {
    console.log("Reclassified " + reclassified + " events as Nightlife & Electronic");
  }

  let toComedy = 0;
  all.forEach((e) => {
    if (e.category !== "Comedy" && isComedy(e)) {
      e.category = "Comedy";
      toComedy++;
    }
  });
  if (toComedy) {
    console.log("Reclassified " + toComedy + " events as Comedy");
  }

  let toMarkets = 0;
  all.forEach((e) => {
    if (e.category !== "Markets & Festivals" && isMarketOrFestival(e)) {
      e.category = "Markets & Festivals";
      toMarkets++;
    }
  });
  if (toMarkets) console.log("Gathered " + toMarkets + " into Markets & Festivals");

  let moved = 0;
  all.forEach((e) => {
    const shelf = refineActive(e);
    if (shelf && shelf !== e.category) { e.category = shelf; moved++; }
  });
  if (moved) console.log("Moved " + moved + " events between Sport and Fitness");

  let refined = 0;
  let leftover = 0;
  all.forEach((e) => {
    if (e.category !== "Live Music") return;
    const shelf = refineMusic(e);
    if (shelf) {
      e.category = shelf;
      refined++;
    } else {
      e.category = "Other Music";
      leftover++;
    }
  });
  console.log("Sorted " + refined + " ungenred music events by genre, " +
    leftover + " left as Other Music\n");

  // Written only now — after consolidation and reclassification, not before.
  fs.writeFileSync(
    path.join(__dirname, "events.js"),
    "window.EVENT_DATA = " +
      JSON.stringify(
        { generated: new Date().toISOString(), shelfOrder: SHELF_ORDER, events: all },
        null, 1
      ) +
      ";\n"
  );

  const bySource = {};
  const byCat = {};
  all.forEach((e) => {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    byCat[e.category] = (byCat[e.category] || 0) + 1;
  });

  const withImage = {};
  all.forEach((e) => {
    if (e.image) withImage[e.source] = (withImage[e.source] || 0) + 1;
  });

  console.log("Wrote events.js — " + all.length + " events");
  console.log("By source:", bySource);
  Object.keys(bySource).forEach((s) => {
    const n = withImage[s] || 0;
    console.log("  " + s + ": " + n + "/" + bySource[s] + " have images");
  });
  console.log("By category:", byCat);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

module.exports = {
  isMarketOrFestival, refineActive, refineMusic, isComedy, consolidateCategory, SHELF_ORDER, CATEGORY_MAP, moshtix, moshtixImage, parseMoshtixDate, moshtixSlug, moshtixPage, SYDNEY,
  isNightlife, matchesVenue, findEventHits, pickImage, sizeImage, harvestEvents, fromNextData, fromJsonLd, parseWhen, extractNextData,
  extractJsonLd, findLdEvents, findSectionSlugs, findEventSlugs, dedupe, titleCase
};
