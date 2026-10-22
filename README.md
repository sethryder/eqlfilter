# EQLFilter

Loot filter builder for *EverQuest Legends*. Single-screen React app, fully client-side
(localStorage + base64 share links) — no backend, hosted on GitHub Pages. Design spec: `docs/design_handoff_eql_filter/README.md`.

## Develop

```sh
npm install
npm run dev        # vite dev server
npm run build      # -> dist/  (static, deploy anywhere)
npm run typecheck  # tsc, optional; build doesn't typecheck
```

## Deploy (GitHub Pages)

Pushes to `main` build and deploy via `.github/workflows/pages.yml` (Pages source must be set to
"GitHub Actions" in repo settings). `public/CNAME` pins the custom domain `eqlfilter.washclof.com`;
point that hostname at `sethryder.github.io` with a DNS CNAME and enable "Enforce HTTPS" in Pages.

Pages sets its own `Cache-Control` (10 min) on every file and that is fine here: Vite fingerprints
`/assets/*`, so a new build never collides with an old filename, and `index.html` / `eql-items.json`
pick up changes within the TTL. Single route with hash-based share links, so no SPA fallback is needed.

## Item catalog (`public/eql-items.json`)

The app loads this file at runtime — updating items is a data swap, no app rebuild needed.
Each item is `{ name, type, slot, zones: string[], flags: string[] }`; `type` is one of Weapon / Armor /
Jewelry / Tradeskill / Container / Misc. `zones` is a list (items drop in many zones); the zone filter
matches membership and the subtitle summarizes ">1" as "N zones".

`eql-items.json` is **built** from layered sources in `data/`. The **classic layer is the authoritative
item set** — EQ Legends launches classic-only (0 expansions), so the catalog must not carry later-era
items. Later layers **enrich** the classic base field-by-field by item name (a Legends entry overrides an
item's type/slot/flags while keeping its classic zones) but **do not add new items** — the wiki/custom
layers span all expansions, and adding them would reintroduce non-classic content. See
`docs/building-eq_classic-csv.md` for how the classic base is built and expansion-filtered.

| Layer | Source | Command |
|---|---|---|
| `data/items.classic.json` | EQEMU classic base (`eq_classic.csv`) | `npm run items:import [file.csv]` |
| `data/items.legends.json` | EQL Wiki scrape (Legends items/overrides) | `npm run items:scrape` |
| `data/items.custom.json` | names harvested from player-exported `.ini`s (drop them in `submissions/`) | `npm run items:merge -- submissions/*.ini` |
| → `public/eql-items.json` | **merge of all present layers** | `npm run items:build` |

Workflow: refresh a layer (import / scrape / merge), then `npm run items:build` to rebuild the catalog.

- `items:import` maps EQEMU's ~35 item types to the 6 categories and splits pipe-delimited zones (no flags in that source). The `eq_classic.csv` it reads is itself extracted from the ProjectEQ DB dump — see `docs/building-eq_classic-csv.md` to regenerate it.
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
