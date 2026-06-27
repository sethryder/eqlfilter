#!/usr/bin/env node
// Convert the EQEMU export (eq_classic.csv: id,name,item_type,slot,zones) into
// the catalog the app loads (public/eql-items.json).
//
//   node tools/import-eqemu.mjs [input.csv]   # default: eq_classic.csv
//
// EQEMU's 35 item_type values collapse to our 6 filter categories. zones is
// pipe-delimited and kept as an array (items drop in many zones). No flags in
// this source — left empty, backfill later. No npm deps.
//
// Writes the classic base layer; run `items:build` afterward to merge all
// layers into public/eql-items.json.

import { readFileSync, writeFileSync } from 'node:fs'

const IN = process.argv[2] || 'eq_classic.csv'
const OUT = 'data/items.classic.json'

// EQEMU item_type -> our category. Anything unlisted falls through to Misc.
const WEAPON = new Set(['1H Slashing', '1H Piercing', '1H Blunt', '2H Slashing', '2H Blunt', '2H Piercing', 'Hand to Hand', 'Bow', 'Throwing', 'Arrow'])
const ARMOR = new Set(['Armor', 'Shield', 'Mask'])
function mapType(t) {
  if (ARMOR.has(t)) return 'Armor'
  if (t === 'Jewelry') return 'Jewelry'
  if (t === 'Tradeskill') return 'Tradeskill'
  if (WEAPON.has(t)) return 'Weapon'
  return 'Misc'
}

// Minimal RFC4180 CSV parser (quoted fields, embedded commas/quotes/newlines).
function parseCSV(text) {
  const rows = []
  let row = [], field = '', i = 0, inQ = false
  while (i < text.length) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue } inQ = false; i++; continue }
      field += c; i++; continue
    }
    if (c === '"') { inQ = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const rows = parseCSV(readFileSync(IN, 'utf8'))
const head = rows.shift().map(h => h.trim())
const col = name => head.indexOf(name)
const ci = {
  name: col('name'), type: col('item_type'), slot: col('slot'), zones: col('zones'), icon: col('icon_id'),
  // Flag columns are 1 = set (intuitive orientation, confirmed against the data).
  no_drop: col('no_drop'), lore: col('lore'), magic: col('magic'), quest: col('quest'),
}
// col===-1 (older CSV without the column) -> r[-1] is undefined -> flag absent.
const FLAG_COLS = [['no_drop', 'NO DROP'], ['lore', 'LORE'], ['magic', 'MAGIC'], ['quest', 'QUEST']]

// Dedupe by name; merge the zone lists if a name appears more than once.
const byName = new Map()
for (const r of rows) {
  const name = (r[ci.name] || '').trim()
  if (!name) continue
  const itemType = (r[ci.type] || '').trim()
  const type = mapType(itemType)
  let slot = (r[ci.slot] || '').trim()
  // The weapon class (e.g. "1H Slashing") is more useful in the subtitle than the
  // equip slot ("Primary"); for typed consumables with no slot, show the type.
  if (WEAPON.has(itemType)) slot = itemType
  else if (!slot && itemType && itemType !== type) slot = itemType
  const zones = (r[ci.zones] || '').split('|').map(z => z.trim()).filter(Boolean)
  const flags = FLAG_COLS.filter(([c]) => r[ci[c]] === '1').map(([, label]) => label)
  // EQ item icons live in dragitem*.dds sheets; ids start at 500. 0/blank = no icon.
  const icon = parseInt(r[ci.icon], 10) >= 500 ? parseInt(r[ci.icon], 10) : 0
  // subtype drives the in-app subcategory chips: weapon class for weapons (the
  // equip slot lives in `slot`), empty otherwise (Armor/Jewelry subcat by slot).
  const subtype = WEAPON.has(itemType) ? itemType : ''

  const key = name.toLowerCase()
  const prev = byName.get(key)
  if (prev) {
    for (const z of zones) if (!prev.zones.includes(z)) prev.zones.push(z)
    for (const f of flags) if (!prev.flags.includes(f)) prev.flags.push(f)
    if (!prev.icon && icon) prev.icon = icon
    if (!prev.subtype && subtype) prev.subtype = subtype
  } else {
    byName.set(key, { name, type, slot, zones, flags, icon, subtype })
  }
}

const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
for (const it of items) it.zones.sort()
writeFileSync(OUT, JSON.stringify(items) + '\n')

const multi = items.filter(i => i.zones.length > 1).length
const counts = items.reduce((m, i) => ((m[i.type] = (m[i.type] || 0) + 1), m), {})
const flagged = items.filter(i => i.flags.length).length
console.log(`Wrote ${items.length} items to ${OUT} (${multi} multi-zone, ${flagged} with flags).`)
console.log('By category:', counts)
