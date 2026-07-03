#!/usr/bin/env node
// Harvest item facts from user-submitted .ini exports into the custom layer
// (data/items.custom.json). The game's caret format carries the three facts the
// catalog wants: ITEM_ID, ICON_ID and the item name. Two kinds of harvest:
//   - a name the catalog doesn't know  -> new stub carrying the game id + icon
//   - a name it knows but with a missing id or different icon -> custom override
//     (the game file is ground truth; wiki/PEQ icons lose)
// The app's old [Rules] Name=Action format still parses, but yields names only.
//
//   node tools/merge-ini.mjs submissions/*.ini        # harvest
//   node tools/merge-ini.mjs --dry submissions/*.ini  # show what WOULD change
//
// Run `npm run items:build` afterward: custom entries with a game itemId are
// ADDED to the catalog (the id proves the item is live in Legends); id-less
// name stubs only enrich, same as before. Dynamic " +N" enchant suffixes are
// stripped — the id belongs to the base item (see parseIni in src/App.tsx).
//
// The submissions dir is filled by tools/server/submit.php (the app POSTs a
// copy of any informative import). Actions (Loot/Sell/…) are per-player
// preference, not item data — ignored.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CATALOG = 'public/eql-items.json'   // full built catalog — read-only here
const CUSTOM = 'data/items.custom.json'   // the layer this script writes
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const files = args.filter(a => a !== '--dry')

if (!files.length) {
  console.error('usage: node tools/merge-ini.mjs [--dry] <file.ini> [more.ini ...]')
  process.exit(1)
}

// name -> {name, itemId, icon}; caret rows carry ids, [Rules] rows names only.
function parseIni(text) {
  const out = new Map()
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === ';' || line[0] === '#') continue
    const car = line.split('^')
    if (car.length >= 4 && parseInt(car[0], 10) > 0) {
      const name = car.slice(3).join('^').trim().replace(/ \+\d+$/, '')
      if (!name) continue
      const prev = out.get(name.toLowerCase())
      const it = { name, itemId: parseInt(car[0], 10) || 0, icon: parseInt(car[2], 10) || 0 }
      if (!prev || !prev.itemId) out.set(name.toLowerCase(), it)
      continue
    }
    if (line[0] === '[') { section = line.replace(/[\[\]]/g, '').trim().toLowerCase(); continue }
    const eq = line.indexOf('=')
    if (eq > 0 && section === 'rules') {
      const name = line.slice(0, eq).trim().replace(/ \+\d+$/, '')
      if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, itemId: 0, icon: 0 })
    }
  }
  return [...out.values()]
}

const catalog = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : []
const custom = existsSync(CUSTOM) ? JSON.parse(readFileSync(CUSTOM, 'utf8')) : []
const catBy = new Map(catalog.map(c => [c.name.toLowerCase(), c]))
const custBy = new Map(custom.map(c => [c.name.toLowerCase(), c]))

const added = [], updated = []
for (const file of files) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) {
    console.error(`skip ${file}: ${e.message}`); continue
  }
  for (const it of parseIni(text)) {
    const key = it.name.toLowerCase()
    const cust = custBy.get(key)
    const cat = catBy.get(key)
    const cur = cust || cat
    if (!cur) {
      const stub = { name: it.name, type: 'Misc', slot: '', zones: [], flags: [], icon: it.icon, itemId: it.itemId, subtype: '' }
      custBy.set(key, stub); custom.push(stub); added.push(stub)
      continue
    }
    // News? A game id we lack, or a game icon disagreeing with what we ship.
    if (!it.itemId || (cur.itemId === it.itemId && (cur.icon || 0) === it.icon)) continue
    if (cur.itemId && cur.itemId !== it.itemId) {
      console.error(`  ! ${it.name}: id conflict (have ${cur.itemId}, file says ${it.itemId}) — kept ours, check manually`)
      continue
    }
    if (cust) { cust.itemId = it.itemId; cust.icon = it.icon; updated.push(cust) }
    else {
      const override = { ...cat, itemId: it.itemId, icon: it.icon }
      delete override.id
      custBy.set(key, override); custom.push(override); updated.push(override)
    }
  }
}

if (!added.length && !updated.length) {
  console.log('No news — catalog already covers every submitted item.')
  process.exit(0)
}
for (const s of added) console.log(`  + ${s.name} (id ${s.itemId || '?'}, icon ${s.icon || '?'})`)
for (const s of updated) console.log(`  ~ ${s.name} -> id ${s.itemId}, icon ${s.icon}`)
console.log(`${added.length} new, ${updated.length} updated${dry ? ' (dry run, nothing written)' : ''}`)

if (!dry) {
  writeFileSync(CUSTOM, JSON.stringify(custom, null, 2) + '\n')
  console.log(`Wrote ${custom.length} item(s) to ${CUSTOM}. Run \`npm run items:build\` to fold into the catalog.`)
}
