#!/usr/bin/env node
// Merge the per-source item layers into the catalog the app loads.
//
//   node tools/build-catalog.mjs
//
// Sources are merged low→high precedence; a later layer overrides an earlier one
// by item name, field-by-field (it only overrides fields it actually has, so the
// Legends scrape can override type/slot while keeping classic zones, etc.).
//
//   data/items.classic.json  — EQEMU classic base        (items:import)
//   data/items.legends.json  — EQL Wiki / Legends items   (items:scrape)
//   data/items.custom.json   — names from submitted INIs  (items:merge)
//
// Run this after refreshing any layer. No npm deps.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const SOURCES = ['data/items.classic.json', 'data/items.legends.json', 'data/items.custom.json']
const OUT = 'public/eql-items.json'

// Normalize either the zones[] shape or an older single `zone` string, and drop
// the legacy "—" empty-slot placeholder.
function norm(it) {
  return {
    name: (it.name || '').trim(),
    type: it.type || 'Misc',
    slot: it.slot && it.slot !== '—' ? it.slot : '',
    zones: Array.isArray(it.zones) ? it.zones.filter(Boolean) : (it.zone ? [it.zone] : []),
    flags: Array.isArray(it.flags) ? it.flags : [],
    icon: it.icon || 0,
    subtype: it.subtype || '',
  }
}

const byName = new Map()
const stats = []
for (const src of SOURCES) {
  if (!existsSync(src)) { stats.push({ src, added: 0, overrode: 0, skipped: true }); continue }
  const arr = JSON.parse(readFileSync(src, 'utf8'))
  let added = 0, overrode = 0
  for (const raw of arr) {
    const it = norm(raw)
    if (!it.name) continue
    const key = it.name.toLowerCase()
    const prev = byName.get(key)
    if (!prev) { byName.set(key, it); added++; continue }
    byName.set(key, {
      name: it.name,
      type: it.type || prev.type,
      slot: it.slot || prev.slot,
      zones: it.zones.length ? it.zones : prev.zones,
      flags: it.flags.length ? it.flags : prev.flags,
      icon: it.icon || prev.icon,
      subtype: it.subtype || prev.subtype,
    })
    overrode++
  }
  stats.push({ src, added, overrode })
}

const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
for (const it of items) it.zones.sort()
writeFileSync(OUT, JSON.stringify(items) + '\n')

console.log(`Merged ${items.length} items -> ${OUT}`)
for (const s of stats) {
  if (s.skipped) console.log(`  ${s.src}: (absent, skipped)`)
  else console.log(`  ${s.src}: +${s.added} new, ${s.overrode} overrides`)
}
