#!/usr/bin/env node
// build-eql-items.mjs
// Generates eql-items.json for the EQL Filter builder by scraping the
// EverQuest Legends Wiki (https://eqlwiki.com) via its MediaWiki API.
//
// Run:  node build-eql-items.mjs > eql-items.json
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
const UA = "EQLFilter-item-builder/1.0 (https://eqlfilter.com)";

// Map a wiki type-subcategory -> the `type` bucket the app uses.
// Add/adjust as you discover the wiki's real subcategory names.
const TYPE_CATEGORIES = {
  "Weapons": "Weapon",
  "1H Slashing": "Weapon", "2H Slashing": "Weapon",
  "1H Blunt": "Weapon", "2H Blunt": "Weapon",
  "Piercing": "Weapon", "Hand to Hand": "Weapon", "Archery": "Weapon",
  "Armor": "Armor", "Equipment": "Armor",
  "Containers": "Container",
  "Tradeskill Ingredient": "Tradeskill", "Tradeskills": "Tradeskill",
  "Light source": "Misc", "Book": "Misc", "Foraged": "Misc",
};

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

// Raw wikitext for a page.
async function wikitext(title) {
  const data = await api({
    action: "query", prop: "revisions", rvprop: "content",
    rvslots: "main", titles: title,
  });
  const page = data?.query?.pages?.[0];
  return page?.revisions?.[0]?.slots?.main?.content ?? "";
}

// Parse slot + flags from a page's wikitext.
// TODO: tune these regexes to the wiki's actual item template once you've
// inspected a page with `--inspect`. The patterns below match the plain
// "Slot: NECK" / "MAGIC ITEM" / "NO DROP" / "LORE ITEM" style tooltips.
function parseItem(text) {
  const slot = (text.match(/Slot:\s*([A-Z0-9 ]+)/i) || [])[1]?.trim() || "";
  const flags = [];
  if (/NO\s*DROP/i.test(text)) flags.push("NO DROP");
  if (/LORE\s*(ITEM|EQUIPPED)?/i.test(text)) flags.push("LORE");
  if (/MAGIC\s*ITEM/i.test(text)) flags.push("MAGIC");
  if (/QUEST\s*ITEM/i.test(text)) flags.push("QUEST");
  return { slot: titleCase(slot), flags };
}

const titleCase = (s) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

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

  // 1) Build name -> type from the type subcategories.
  process.stderr.write("Resolving item types from subcategories...\n");
  const typeByName = new Map();
  for (const [cat, type] of Object.entries(TYPE_CATEGORIES)) {
    try {
      for (const t of await categoryMembers(cat)) {
        if (!typeByName.has(t)) typeByName.set(t, type);
      }
    } catch (e) {
      process.stderr.write(`  (skipped Category:${cat}: ${e.message})\n`);
    }
  }

  // 2) Enumerate every item.
  process.stderr.write("Enumerating Category:Items...\n");
  const allItems = await categoryMembers("Items");

  // 3) Fetch each item's page and parse slot + flags. Be polite: throttle.
  process.stderr.write(`Fetching details for ${allItems.length} items...\n`);
  const out = [];
  for (let i = 0; i < allItems.length; i++) {
    const name = allItems[i];
    try {
      const { slot, flags } = parseItem(await wikitext(name));
      out.push({
        name,
        type: typeByName.get(name) || "Misc",
        slot: slot || "—",
        zone: "",                // optionally backfill from zone "Known Loot" pages
        flags,
      });
    } catch (e) {
      out.push({ name, type: typeByName.get(name) || "Misc", slot: "—", zone: "", flags: [] });
    }
    if (i % 25 === 0) process.stderr.write(`  ${i}/${allItems.length}\r`);
    await sleep(120); // ~8 req/s — keep it gentle on the wiki
  }
  process.stderr.write(`\nDone. ${out.length} items.\n`);

  out.sort((a, b) => a.name.localeCompare(b.name));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
