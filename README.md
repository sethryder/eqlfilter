# EQLFilter

Loot filter builder for *EverQuest Legends*. Single-screen React app, fully client-side
(localStorage + base64 share links) — no backend. Design spec: `docs/design_handoff_eql_filter/README.md`.

## Develop

```sh
npm install
npm run dev        # vite dev server
npm run build      # -> dist/  (static, deploy anywhere)
npm run typecheck  # tsc, optional; build doesn't typecheck
```

## Deploy (Laravel Forge)

It's a static site — no PHP process. Point a Forge **static** site at `dist/`, or build on the
server and serve `dist/` with nginx.

### nginx (caching + SPA routing)

The whole caching strategy is one rule: **hashed files cache forever, everything else
revalidates.** Vite fingerprints `/assets/*` (e.g. `index-BnccLqB8.js`), so those can be
immutable for a year — a new build means a new filename. Everything in the site root is
*unhashed* and can change in place (`index.html` on every deploy, `eql-items.json` on a data
swap), so it must revalidate or users get stale references to assets that no longer exist.

```nginx
# Fingerprinted build assets — filename changes when content does, cache forever.
location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
}

# Item catalog — swapped in place without a new name, so always revalidate.
# nginx serves an ETag, so revalidation is a cheap 304 when it hasn't changed.
location = /eql-items.json {
    add_header Cache-Control "no-cache";
}

# Icons / og image / favicon — unhashed but rarely change. A week is a safe middle;
# bump the filename or purge if you replace one.
location ~* \.(png|svg|ico|webp)$ {
    add_header Cache-Control "public, max-age=604800";
    try_files $uri =404;
}

# App shell + SPA fallback. index.html points at the hashed assets, so it must never
# be cached long — otherwise a deploy ships new assets the old HTML can't find.
location = /index.html {
    add_header Cache-Control "no-cache";
}
location / {
    try_files $uri $uri/ /index.html;
}
```

Note: `add_header` set in a `location` drops any `add_header` inherited from the `server`
block — so keep security/other headers inside each location, or define them server-wide and
re-`add_header` them here. Verify with `curl -I https://eqlfilter.com/assets/<file>.js`.

### CloudFlare

CloudFlare's defaults already do most of the right thing; the goal is to let the origin
headers above drive everything.

- **Caching → Configuration → Browser Cache TTL: "Respect Existing Headers."** Without this,
  CF overrides our `Cache-Control` with its own TTL and the immutable/no-cache split is lost.
- **Default behavior is correct out of the box:** CF edge-caches static extensions (`/assets/*.js`,
  `.css`, `.png`, `.svg`) but does **not** edge-cache `.html` or `.json`. That's exactly what we
  want — `index.html` and `eql-items.json` keep hitting the origin and revalidating, so deploys
  and data swaps go live immediately. **Do not turn on a "Cache Everything" page rule** — it
  would cache `index.html` at the edge and serve stale builds.
- **On deploy:** nothing to purge. Assets are hashed (new names) and HTML/JSON aren't edge-cached.
- **On a data swap** (`eql-items.json`): also nothing required, since CF doesn't edge-cache JSON
  by default. *If* you ever add a Cache Rule that caches it at the edge, purge that URL after a swap
  (`Caching → Purge → Custom URL`).
- **Free wins to toggle on:** Brotli, HTTP/3, Always Use HTTPS, Tiered Cache. Skip Auto Minify —
  Vite already minifies, and CF deprecated it.

Single-page app, so all routes fall back to `index.html` (the `location /` block above).

## Item catalog (`public/eql-items.json`)

The app loads this file at runtime — updating items is a data swap, no app rebuild needed.
Each item is `{ name, type, slot, zones: string[], flags: string[] }`; `type` is one of Weapon / Armor /
Jewelry / Tradeskill / Container / Misc. `zones` is a list (items drop in many zones); the zone filter
matches membership and the subtitle summarizes ">1" as "N zones".

`eql-items.json` is **built** from layered sources in `data/`, merged low→high precedence (a later layer
overrides an earlier one by item name, field-by-field — so a Legends entry can override an item's type
while keeping its classic zones). EverQuest Legends adds/changes items, so the Legends layer sits on top
of the EQEMU classic base.

| Layer | Source | Command |
|---|---|---|
| `data/items.classic.json` | EQEMU classic base (`eq_classic.csv`) | `npm run items:import [file.csv]` |
| `data/items.legends.json` | EQL Wiki scrape (Legends items/overrides) | `npm run items:scrape` |
| `data/items.custom.json` | names harvested from submitted player `.ini`s | `npm run items:merge -- submissions/*.ini` |
| → `public/eql-items.json` | **merge of all present layers** | `npm run items:build` |

Workflow: refresh a layer (import / scrape / merge), then `npm run items:build` to rebuild the catalog.

- `items:import` maps EQEMU's ~35 item types to the 6 categories and splits pipe-delimited zones (no flags in that source).
- `items:scrape` (`tools/build-eql-items.mjs`) hits the EQL Wiki MediaWiki API and parses each item page's
  `{{Itempage}}` template: statsblock → slot/flags (handles "NO TRADE"), `[[Category:…]]` → type. Zones come
  from the item's `dropsfrom` **and** its zone categories (an item in a zone is in `Category:<Zone>`, which is
  what drives the zone pages) — matched against the names in `Category:Zones`, with the "The …" prefix
  variants reconciled. Full run is ~10,600 items at ~8 req/s (~20 min); `--limit N` for a quick test,
  `--no-zones` to skip the zone set, `--inspect "Item Name"` to dump raw wikitext. Type classification is
  heuristic — refine `classifyType()` if a bucket looks off.
- `items:merge` adds unknown names as `Misc` stubs to the custom layer; enrich them later. `--dry` previews.

## Item icons (`public/icons/`)

Real icons extracted from the EQ Legends client's `dragitem*.dds` sheets (256×256, 6×6 grid of
40×40 cells, **column-major**, icon ids start at 500). `npm run icons:extract [client_uifiles_dir]`
converts just the sheets the catalog references (via ImageMagick — `magick` must be installed) into
`public/icons/dragitemN.png`. The app positions each icon with the same math (`iconBadge` in
`src/App.tsx`); items without an icon fall back to the lettered type dot. Icon ids ride along from
`eq_classic.csv`'s `icon_id` through `items:import` → `items:build`. Re-run `icons:extract` after a
catalog rebuild if new icon ids appear.

## Loot-filter format

EQ Legends uses the in-game **Advanced Loot > Filters** system (per-character, set per item to
**Loot / Merge / Store / Sell**, copied between chars via Merge/Replace). There's no importable file —
the app's INI export (`buildIni`/`parseIni`) is a share format for this tool, with actions matching
the game's four. `merge-ini.mjs` reads the same `[Rules]` `Name=Action` shape.
