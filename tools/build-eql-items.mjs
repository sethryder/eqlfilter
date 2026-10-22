#!/usr/bin/env node
// build-eql-items.mjs
// Generates eql-items.json for the EQL Filter builder by scraping the
// EverQuest Legends Wiki (https://eqlwiki.com) via its MediaWiki API.
//
// Run:  node build-eql-items.mjs > data/items.legends.json
//       (then `npm run items:build` to merge layers into public/eql-items.json)
// Needs: Node 18+ (built-in fetch). No npm install required.
//
// WHY THIS EXISTS
// The wiki lists ~10,600 items under Category:Items, each on its own page.
// You don't want to hand-enter those. MediaWiki exposes everything through
// /api.php, so we:
//   1) Enumerate every item title via the category.
//   2) Tag each item's TYPE by which type-subcategory it belongs to
//      (Weapons, Containers, Light source, Tradeskill Ingredient, Book, ...).
//   3) Pull each page's wikitext and parse the item infobox/tooltip for
//      slot + flags (NO DROP / LORE / MAGIC / QUEST).
//
// IMPORTANT: step 3's field names depend on the wiki's item template, which
// we can't see from here. Run with --inspect "Onyx Earring" first to dump one
// page's raw wikitext, then adjust parseItem() to match the real template
// parameter names. Everything else works as-is.

const API = "https://eqlwiki.com/api.php";
const UA = "EQLFilter-item-builder/1.0 (https://eqlfilter.washclof.com)";

// Weapon-skill categories on an item page mean it's a Weapon. (Confirmed against
// the live wiki: pages carry [[Category:1H Slashing]] etc.)
const WEAPON_CATS = new Set([
  "1H Slashing", "2H Slashing", "1H Blunt", "2H Blunt", "1H Piercing", "2H Piercing",
  "Piercing", "Hand to Hand", "Archery", "Throwing", "Ammo",
]);

async function api(params) {
  const url = new URL(API);
  url.search = new URLSearchParams({ format: "json", formatversion: "2", ...params }).toString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return res.json();
    await sleep(500 * (attempt + 1));
  }
  throw new Error("API failed: " + url);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All page titles in a category (handles continuation).
async function categoryMembers(category) {
  const titles = [];
  let cont;
  do {
    const data = await api({
      action: "query", list: "categorymembers",
      cmtitle: "Category:" + category, cmtype: "page",
      cmlimit: "500", ...(cont ? { cmcontinue: cont } : {}),
    });
    for (const m of data?.query?.categorymembers ?? []) titles.push(m.title);
    cont = data?.continue?.cmcontinue;
    process.stderr.write(`  ${category}: ${titles.length}\r`);
  } while (cont);
  process.stderr.write("\n");
  return titles;
}

// The set of valid zone NAMES, used to pick out which of an item's
// [[Category:…]] tags are zones. Items carry a zone category (e.g.
// [[Category:Northern Desert of Ro]]) that matches the zone page modulo a
// leading "The" — the zone page is "The Northern Desert of Ro" but items use
// the shorter form (which also matches EQEMU's zone naming). We add both
// variants so either form on an item resolves.
async function buildZoneNameSet() {
  const set = new Set();
  for (const title of await categoryMembers("Zones")) {
    set.add(title);
    set.add(title.replace(/^The\s+/i, ""));
    if (!/^The\s+/i.test(title)) set.add("The " + title);
  }
  process.stderr.write(`Zone name set: ${set.size} names\n`);
  return set;
}

// Raw wikitext for a page.
async function wikitext(title) {
  const data = await api({
    action: "query", prop: "revisions", rvprop: "content",
    rvslots: "main", titles: title,
  });
  const page = data?.query?.pages?.[0];
  return page?.revisions?.[0]?.slots?.main?.content ?? "";
}

const titleCase = (s) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Extract one {{Itempage}} template parameter (value runs until the next "|param"
// line or the closing "}}").
function param(text, name) {
  const m = text.match(new RegExp("\\|\\s*" + name + "\\s*=([\\s\\S]*?)(?=\\n\\s*\\||\\n\\}\\})"));
  return m ? m[1].trim() : "";
}

function classifyType(cats, slot, skill) {
  if (skill || cats.some((c) => WEAPON_CATS.has(c))) return "Weapon";
  if (cats.some((c) => /Tradeskill|Ingredient|Foraged/i.test(c))) return "Tradeskill";
  if (cats.some((c) => /^(Bag|Container)\b/i.test(c))) return "Container";
  const s = slot.toUpperCase();
  if (/\b(EAR|FINGER)\b/.test(s)) return "Jewelry";   // ear/finger are exclusively jewelry
  if (slot) return "Armor";                           // any other equip slot
  return "Misc";
}

// Parse the full item record from a page's wikitext. `zoneSet` (from
// buildZoneNameSet) picks the item's zone categories; omit it to rely on
// `dropsfrom` alone.
function parseItem(title, text, zoneSet = new Set()) {
  const stats = param(text, "statsblock");
  const cats = [...text.matchAll(/\[\[Category:\s*([^\]|]+)/g)].map((m) => m[1].trim());

  const flags = [];
  if (/NO\s*DROP|NO\s*TRADE/i.test(stats)) flags.push("NO DROP");
  if (/LORE\s*(ITEM|EQUIPPED)?/i.test(stats) || cats.some((c) => /^Lore/i.test(c))) flags.push("LORE");
  if (/MAGIC\s*ITEM/i.test(stats)) flags.push("MAGIC");
  if (/QUEST\s*ITEM/i.test(stats) || cats.includes("Quest Items")) flags.push("QUEST");

  const slot = titleCase(((stats.match(/Slot:\s*([A-Za-z0-9 ,]+?)\s*<br/i) || [])[1] || "").trim());
  const skill = (stats.match(/Skill:\s*([A-Za-z0-9 ]+?)\s+(?:Atk|<br)/i) || [])[1]?.trim() || "";

  // Zones from two sources, unioned:
  //  1) non-bulleted [[Zone]] links in dropsfrom (mobs are "* [[mob]]" sub-bullets)
  //  2) the item's [[Category:Zone]] tags (more complete; drives the zone pages)
  const zones = [];
  const addZone = (z) => { z = z.trim(); if (z && !zones.includes(z)) zones.push(z); };
  for (const line of param(text, "dropsfrom").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("*")) continue;
    const m = t.match(/^\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/);
    if (m) addZone(m[1]);
  }
  for (const c of cats) if (zoneSet.has(c)) addZone(c);

  // lucy_img_ID is the EQ icon id (same space as eq_classic.csv's icon_id, ids ≥500);
  // feeds the dragitem*.dds sheet extraction in tools/extract-icons.mjs.
  const icon = parseInt(param(text, "lucy_img_ID"), 10) >= 500 ? parseInt(param(text, "lucy_img_ID"), 10) : 0;

  const type = classifyType(cats, slot, skill);
  // Weapon class for the subcategory chips (e.g. "1H Slashing"): prefer the
  // page's Skill line, else the matched weapon category. Empty for non-weapons.
  const subtype = type === "Weapon" ? (skill || cats.find((c) => WEAPON_CATS.has(c)) || "") : "";

  return {
    name: param(text, "itemname") || title,
    type,
    slot,
    zones,
    flags,
    icon,
    subtype,
  };
}

async function main() {
  const args = process.argv.slice(2);

  // --inspect "Item Name": dump one page's wikitext so you can map the template.
  const inspectIdx = args.indexOf("--inspect");
  if (inspectIdx !== -1) {
    const title = args[inspectIdx + 1];
    process.stderr.write(`Wikitext for "${title}":\n\n`);
    console.log(await wikitext(title));
    return;
  }

  // --limit N: only process the first N items (for a quick test run).
  const limIdx = args.indexOf("--limit");
  const limit = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : Infinity;

  // Valid zone names, to pick zone categories off each item (skip under --no-zones).
  const zoneSet = args.includes("--no-zones") ? new Set() : await buildZoneNameSet();

  process.stderr.write("Enumerating Category:Items...\n");
  const allItems = await categoryMembers("Items");
  const workList = Number.isFinite(limit) ? allItems.slice(0, limit) : allItems;

  process.stderr.write(`Fetching details for ${workList.length} items...\n`);
  const out = [];
  const failed = [];
  for (let i = 0; i < workList.length; i++) {
    const title = workList[i];
    try {
      const item = parseItem(title, await wikitext(title), zoneSet);
      item.zones.sort();
      out.push(item);
    } catch (e) {
      // Skip rather than emit a stub: a "Misc" stub would override the item's real
      // type in build-catalog, so a flaky wiki day would silently demote items.
      failed.push(title);
    }
    if (i % 25 === 0) process.stderr.write(`  ${i}/${workList.length}\r`);
    await sleep(120); // ~8 req/s — keep it gentle on the wiki
  }
  process.stderr.write(`\nDone. ${out.length} items, ${failed.length} failed.\n`);
  if (failed.length) process.stderr.write(`  failed: ${failed.join(", ")}\n`);
  // ponytail: a handful of failures just drops those names from the enrich layer for
  // this run; many means the wiki was unhealthy, so fail instead of shipping a thin layer.
  if (failed.length > 20) process.exit(1);

  out.sort((a, b) => a.name.localeCompare(b.name));
  console.log(JSON.stringify(out));
}

export { parseItem, wikitext, categoryMembers, buildZoneNameSet };

// Only scrape when run directly, so the parser can be imported for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
