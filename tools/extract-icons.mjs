#!/usr/bin/env node
// Extract item-icon sprite sheets from the EQ Legends client into public/icons/.
//
//   node tools/extract-icons.mjs [client_uifiles_dir]
//   # default: the Public install's uifiles/default
//
// EQ icons live in 256x256 dragitem*.dds sheets, 6x6 grid of 40x40 cells,
// COLUMN-major. Icon id -> sheet/cell:
//   rel = id - 500;  sheet = floor(rel/36)+1;  cell = rel%36
//   x = floor(cell/6)*40 ;  y = (cell%6)*40
// (verified: icon 519 = Two Handed Sword, 524 = Boots). The app uses the same
// math to position each icon — see iconStyle() in src/App.tsx.
//
// Only the sheets actually referenced by public/eql-items.json are converted,
// via ImageMagick (DXT5 DDS -> PNG, alpha preserved). Run after items:build.

import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SRC = process.argv[2] ||
  '/mnt/c/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/uifiles/default'
const OUT = 'public/icons'

const items = JSON.parse(readFileSync('public/eql-items.json', 'utf8'))
const sheets = new Set()
for (const it of items) if (it.icon >= 500) sheets.add(Math.floor((it.icon - 500) / 36) + 1)

mkdirSync(OUT, { recursive: true })
let ok = 0, missing = []
for (const n of [...sheets].sort((a, b) => a - b)) {
  const dds = `${SRC}/dragitem${n}.dds`
  if (!existsSync(dds)) { missing.push(n); continue }
  execFileSync('magick', [dds, `${OUT}/dragitem${n}.png`])
  ok++
}
console.log(`Converted ${ok}/${sheets.size} referenced sheets -> ${OUT}/`)
if (missing.length) console.log(`  missing sheets (no icon shown): ${missing.join(', ')}`)
