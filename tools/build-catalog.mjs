#!/usr/bin/env node
// Merge the per-source item layers into the catalog the app loads.
//
//   node tools/build-catalog.mjs
//
// The classic layer is the AUTHORITATIVE item set — EQ Legends launches classic-only
// (0 expansions), so the catalog must not carry later-era items. The classic base is
// already filtered to items dropping in expansion-0 zones (see
// docs/building-eq_classic-csv.md). Later layers ENRICH it field-by-field by item name
// (override type/slot/flags/icon while keeping classic zones) but DO NOT add new items —
// the wiki/custom layers span all expansions, and adding them would reintroduce non-classic
// content. ponytail: classic is the only additive source; flip `additive` below if a future
// catalog needs to include wiki/custom-only names.
//
//   data/items.classic.json  — EQEMU classic base        (items:import)  [additive]
//   data/items.legends.json  — EQL Wiki / Legends items   (items:scrape)  [enrich-only]
//   data/items.eql.json      — hand-curated Legends-only items (motes etc.) [additive]
//   data/items.custom.json   — names from submitted INIs  (items:merge)   [enrich-only]
//
// items.eql.json exists because Legends-original items (the Motes of Potential) aren't
// in PEQ, and the wiki has no item-id field — ids/icons there come from real in-game
// filter files as players share them (itemId 0 = not yet known, unexportable). It runs
// AFTER the wiki layer so its game-confirmed ids/icons win over scraped values (the
// wiki carries bogus icon ids, e.g. Skeletal Rod 84216 vs the real 905).
//
// Run this after refreshing any layer. No npm deps.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// `additive` layers introduce new item names; enrich-only layers only override names the
// classic base already has. Keep classic-only so the catalog stays classic (0 expansions).
// `addIfClassicZones`: the wiki spans all expansions, but a wiki-only item whose drop
// zones are ALL classic zones is a Legends-original classic drop (e.g. the Befallen set)
// that PEQ can't know about — let those in. Zoneless wiki items stay out (era unknown).
// `addIfItemId`: an ini-harvested custom entry with a game item id is confirmed live
// in Legends (the id came from a real in-game filter file) — let those in too.
const SOURCES = [
  { path: 'data/items.classic.json', additive: true },
  { path: 'data/items.legends.json', additive: false, addIfClassicZones: true },
  { path: 'data/items.eql.json', additive: true },
  { path: 'data/items.custom.json', additive: false, addIfItemId: true },
]
const OUT = 'public/eql-items.json'

// Wiki zone names -> the classic base's long-form names (PEQ zone table). Without this
// the addIfClassicZones gate drops real classic drops (wiki says "Splitpaw Lair", base
// says "The Lair of the Splitpaw") and wiki-filled zones leak inconsistent names into
// the app's zone list. Also folds the classic base's own duplicate spellings (PEQ ships
// e.g. "Plane of Hate" and "The Plane of Hate" as separate rows for the same zone).
// ponytail: hand-curated for classic-era zones only; extend if a later era ever ships.
const ZONE_ALIAS = {
  'Splitpaw': 'The Lair of the Splitpaw',
  'Splitpaw Lair': 'The Lair of the Splitpaw',
  'Lair of the Splitpaw': 'The Lair of the Splitpaw',
  'Cazic Thule': 'Accursed Temple of CazicThule',
  'Cazic-Thule': 'Accursed Temple of CazicThule',
  'Plane of Fear': 'The Plane of Fear',
  'Plane of Hate': 'The Plane of Hate',
  'Plane of Sky': 'The Plane of Sky',
  'Permafrost': 'The Permafrost Caverns',
  'Nektulos Forest': 'The Nektulos Forest',
  'Rathe Mountains': 'The Rathe Mountains',
  'Everfrost': 'Everfrost Peaks',
  'Estate of Unrest': 'The Estate of Unrest',
  'Unrest': 'The Estate of Unrest',
  'Mistmoore Castle': 'The Castle of Mistmoore',
  'Castle Mistmoore': 'The Castle of Mistmoore',
  'Lower Guk': 'The Ruins of Old Guk',
  'Upper Guk': 'The City of Guk',
  'Greater Faydark': 'The Greater Faydark',
  'Lesser Faydark': 'The Lesser Faydark',
  'Lavastorm': 'The Lavastorm Mountains',
  'Lavastorm Mountains': 'The Lavastorm Mountains',
  'North Karana': 'The Northern Plains of Karana',
  'Northern Karana': 'The Northern Plains of Karana',
  'Northern Plains of Karana': 'The Northern Plains of Karana',
  'South Karana': 'The Southern Plains of Karana',
  'Southern Karana': 'The Southern Plains of Karana',
  'Southern Plains of Karana': 'The Southern Plains of Karana',
  'East Karana': 'Eastern Plains of Karana',
  'Eastern Karana': 'Eastern Plains of Karana',
  'West Karana': 'The Western Plains of Karana',
  'Western Karana': 'The Western Plains of Karana',
  'Western Plains of Karana': 'The Western Plains of Karana',
  'Qeynos Hills': 'The Qeynos Hills',
  'Qeynos Aqueducts': 'The Qeynos Aqueduct System',
  'Surefall Glade': 'The Surefall Glade',
  'Highpass Keep': 'High Keep',
  "Beholder's Maze": 'Gorge of King Xorbb',
  'Runnyeye': 'The Liberated Citadel of Runnyeye',
  'Clan RunnyEye': 'The Liberated Citadel of Runnyeye',
  'Clan Runnyeye': 'The Liberated Citadel of Runnyeye',
  'RunnyEye Citadel': 'The Liberated Citadel of Runnyeye',
  'Oasis': 'Oasis of Marr',
  'Neriak Foreign Quarter': 'Neriak - Foreign Quarter',
  'Neriak Third Gate': 'Neriak - 3rd Gate',
  'Kerra Island': 'Kerra Isle',
}

// Normalize either the zones[] shape or an older single `zone` string, and drop
// the legacy "—" empty-slot placeholder. Zones: drop scraper junk (File:/Category:
// links the wiki sometimes puts in dropsfrom), map to canonical classic names, dedupe.
function normZones(zs) {
  return [...new Set(zs.filter(z => z && !/^(file|category):/i.test(z)).map(z => ZONE_ALIAS[z] || z))]
}
function norm(it) {
  return {
    name: (it.name || '').trim(),
    type: it.type || 'Misc',
    slot: it.slot && it.slot !== '—' ? it.slot : '',
    zones: normZones(Array.isArray(it.zones) ? it.zones : (it.zone ? [it.zone] : [])),
    flags: Array.isArray(it.flags) ? it.flags : [],
    icon: it.icon || 0,
    itemId: it.itemId || 0, // game item id — the in-game filter INI keys rows on it
    subtype: it.subtype || '',
  }
}

const byName = new Map()
const stats = []
let classicZones = null // zone set of the classic base; ready once the first layer merges
for (const { path: src, additive, addIfClassicZones, addIfItemId } of SOURCES) {
  if (!existsSync(src)) { stats.push({ src, added: 0, overrode: 0, skipped: true }); continue }
  if (!classicZones && byName.size) classicZones = new Set([...byName.values()].flatMap(i => i.zones))
  const arr = JSON.parse(readFileSync(src, 'utf8'))
  let added = 0, overrode = 0, dropped = 0
  for (const raw of arr) {
    const it = norm(raw)
    if (!it.name) continue
    const key = it.name.toLowerCase()
    const prev = byName.get(key)
    if (!prev) {
      // Enrich-only layers never introduce names — that's how non-classic items stay out —
      // unless the item is provably in Legends: all its zones are classic zones
      // (addIfClassicZones) or it carries a game item id (addIfItemId).
      const classicOnly = addIfClassicZones && it.zones.length && it.zones.every(z => classicZones.has(z))
      if (!additive && !classicOnly && !(addIfItemId && it.itemId > 0)) { dropped++; continue }
      byName.set(key, it); added++; continue
    }
    byName.set(key, {
      name: it.name,
      type: it.type || prev.type,
      slot: it.slot || prev.slot,
      // Classic zones are authoritative (PEQ loot tables) — the wiki's zone lists are
      // sparser and must not replace them; later layers only fill a missing list.
      zones: prev.zones.length ? prev.zones : it.zones,
      flags: it.flags.length ? it.flags : prev.flags,
      icon: it.icon || prev.icon,
      itemId: it.itemId || prev.itemId,
      subtype: it.subtype || prev.subtype,
    })
    overrode++
  }
  stats.push({ src, added, overrode, dropped })
}

const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
for (const it of items) it.zones.sort()
writeFileSync(OUT, JSON.stringify(items) + '\n')

console.log(`Merged ${items.length} items -> ${OUT}`)
for (const s of stats) {
  if (s.skipped) console.log(`  ${s.src}: (absent, skipped)`)
  else console.log(`  ${s.src}: +${s.added} new, ${s.overrode} overrides${s.dropped ? `, ${s.dropped} non-classic skipped` : ''}`)
}
