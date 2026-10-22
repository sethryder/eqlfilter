#!/usr/bin/env node
// Screenshot the built app at one or more viewports — for verifying layout/UI
// changes without a human in the loop.
//
//   npm run build            # shots run against dist/ via `vite preview`
//   node tools/shot.mjs                       # default desktop + short + mobile
//   node tools/shot.mjs 1280x720 390x844      # custom WxH viewports
//   SHOT_URL=http://localhost:5173 node tools/shot.mjs   # use a running server
//
// PNGs land in the scratchpad dir (printed at the end). Uses the cached
// Playwright chromium — no browser download.

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const OUT = process.env.SHOT_DIR || `${tmpdir()}/eqlfilter-shots`
const viewports = (process.argv.slice(2).length ? process.argv.slice(2) : ['1440x900', '1280x720', '390x844'])
  .map(s => { const [w, h] = s.split('x').map(Number); return { w, h, name: s } })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Reuse a running server if SHOT_URL is set; else spin up `vite preview` on dist/.
let server, base = process.env.SHOT_URL
if (!base) {
  base = 'http://localhost:4173'
  server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' })
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
try {
  // Wait for the server to answer.
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base); if (r.ok) break } catch {}
    await sleep(250)
  }
  for (const v of viewports) {
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h } })
    await page.goto(base, { waitUntil: 'networkidle' })
    await sleep(400) // let the catalog fetch + first render settle
    const file = `${OUT}/shot-${v.name}.png`
    await page.screenshot({ path: file })
    console.log('wrote', file)
    await page.close()
  }
} finally {
  await browser.close()
  if (server) server.kill()
}
