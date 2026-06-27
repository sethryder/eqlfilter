#!/usr/bin/env node
// Harvest item NAMES from user-submitted .ini exports and fold any the catalog
// doesn't already cover into the custom layer (data/items.custom.json) as stubs
// (type "Misc", no slot/zones). Lets players help fill catalog gaps just by
// sending their filters — you triage/enrich the stubs later, then `items:build`.
//
//   node tools/merge-ini.mjs submissions/*.ini        # add new names to the custom layer
//   node tools/merge-ini.mjs --dry submissions/*.ini  # show what WOULD be added
//
// "New" is judged against the full built catalog (public/eql-items.json), so an
// item already in the classic/Legends layers won't be re-added. Run `items:build`
// afterward to fold the custom layer into the catalog the app loads.
//
// Only item names are read; the chosen action (Loot/Sell/…) is a per-player
// preference, not item data, so it's intentionally ignored.
// ponytail: stubs only. Enriching slot/zones is a manual/scrape step, not this script's job.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CATALOG = 'public/eql-items.json'   // full built catalog — read-only here, to know what's already covered
const CUSTOM = 'data/items.custom.json'   // the layer this script writes
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const files = args.filter(a => a !== '--dry')

if (!files.length) {
  console.error('usage: node tools/merge-ini.mjs [--dry] <file.ini> [more.ini ...]')
  process.exit(1)
}

// Pull "Name=Value" keys under a [Rules] section — the key is the item name.
function itemNamesFromIni(text) {
  const names = []
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === ';' || line[0] === '#') continue
    if (line[0] === '[') { section = line.replace(/[\[\]]/g, '').trim().toLowerCase(); continue }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (section === 'rules') {
      const name = line.slice(0, eq).trim()
      if (name) names.push(name)
    }
  }
  return names
}

const catalog = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : []
const custom = existsSync(CUSTOM) ? JSON.parse(readFileSync(CUSTOM, 'utf8')) : []
const have = new Set([...catalog, ...custom].map(c => c.name.toLowerCase()))

const added = []
for (const file of files) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) {
    console.error(`skip ${file}: ${e.message}`); continue
  }
  for (const name of itemNamesFromIni(text)) {
    const key = name.toLowerCase()
    if (have.has(key)) continue
    have.add(key)
    const stub = { name, type: 'Misc', slot: '', zones: [], flags: [] }
    added.push(stub)
    custom.push(stub)
  }
}

if (!added.length) {
  console.log('No new items — catalog already covers every submitted name.')
  process.exit(0)
}

console.log(`${added.length} new item(s)${dry ? ' (dry run, nothing written)' : ''}:`)
for (const s of added) console.log('  + ' + s.name)

if (!dry) {
  writeFileSync(CUSTOM, JSON.stringify(custom, null, 2) + '\n')
  console.log(`\nWrote ${custom.length} item(s) to ${CUSTOM}. Stubs are type "Misc" with no slot/zones.`)
  console.log('Run `npm run items:build` to fold them into the catalog.')
}
