# EQLFilter

Loot filter builder for *EverQuest Legends*. Single-screen React app, fully client-side
(localStorage + base64 share links), no backend. Hosted on GitHub Pages at
https://eqlfilter.washclof.com. Design spec: `docs/design_handoff_eql_filter/README.md`.

## Develop

```sh
npm install
npm run dev        # vite dev server
npm run build      # -> dist/  (static)
npm run preview    # serve dist/ locally
npm run typecheck  # tsc, optional; build doesn't typecheck
npm run shot       # screenshot dist/ at desktop/short/mobile viewports (Playwright)
```

## Deploy (GitHub Pages)

Pushes to `main` build and deploy via `.github/workflows/pages.yml`. Nothing to do by hand.

One-time setup (a `CNAME` file is ignored for Actions-based deploys, so the domain lives in repo settings):

```sh
gh api -X POST repos/sethryder/eqlfilter/pages -f build_type=workflow        # enable, source = Actions
gh api -X PUT  repos/sethryder/eqlfilter/pages -f cname=eqlfilter.washclof.com  # custom domain
```

DNS: `CNAME eqlfilter.washclof.com -> sethryder.github.io`, then turn on "Enforce HTTPS" in Settings → Pages.

Pages serves everything with a fixed 10-minute `Cache-Control`. That is fine: Vite fingerprints
`/assets/*` so a new build never collides with an old filename, and `index.html` / `eql-items.json`
pick up changes within the TTL. Single route with hash-based share links, so no SPA fallback.

## Updating things

| Want to | Run |
|---|---|
| Refresh items from the EQL wiki | **Actions → "Refresh items from EQL wiki" → Run workflow** (also runs Mondays). Opens a PR on `auto/wiki-refresh`. Locally: `npm run items:scrape && npm run items:build` |
| Harvest ids/icons from player `.ini` exports | Drop files in `submissions/` (gitignored), then `npm run items:merge -- submissions/*.ini && npm run items:build` |
| Add a Legends-only item (motes etc.) | Edit `data/items.eql.json`, then `npm run items:build` |
| Rebuild the classic base | Regenerate `eq_classic.csv` per `docs/building-eq_classic-csv.md`, then `npm run items:import && npm run items:build` |
| Extract new icon sheets | `npm run icons:extract [client_uifiles_dir]` (needs the EQ Legends client + ImageMagick `magick`) |

`items:build` = `build-catalog.mjs` + `extract-icons.mjs`. The wiki workflow can't extract icons (no game
client on the runner); its PR body lists sheets missing from `public/icons/`. Run `icons:extract`
locally and push to the branch before merging.

## Item catalog (`public/eql-items.json`)

The app fetches this at runtime, so a catalog change is a data swap: no app code changes needed.
Each item is `{ name, type, slot, zones: string[], flags: string[], icon, itemId, subtype }`; `type` is
one of Weapon / Armor / Jewelry / Tradeskill / Container / Misc. `icon` is the game's icon id (500+,
see Icons below); `itemId` is the game's item id (0 = not yet known from a real filter file).

The catalog is **built** from layered sources in `data/`. The **classic layer is the authoritative item
set**: EQ Legends launches classic-only, so the catalog must not carry later-era items. Enrich-only
layers override type/slot/flags/icon by item name but never add items, since the wiki and custom
layers span all expansions.

| Layer | Source | Mode | Command |
|---|---|---|---|
| `data/items.classic.json` | EQEMU classic base (`eq_classic.csv`) | additive | `npm run items:import [file.csv]` |
| `data/items.legends.json` | EQL Wiki scrape | enrich-only | `npm run items:scrape` |
| `data/items.eql.json` | hand-curated Legends-original items | additive | edit by hand |
| `data/items.custom.json` | ids/icons harvested from player `.ini` exports | enrich-only | `npm run items:merge -- submissions/*.ini` |
| → `public/eql-items.json` | merge of all present layers, in that order | | `npm run items:build` |

Later layers win, so game-confirmed ids/icons from `items.eql.json` and `items.custom.json` override
scraped wiki values (the wiki carries some bogus icon ids).

- `items:import` maps EQEMU's ~35 item types to the 6 categories and splits pipe-delimited zones. No
  flags in that source. `eq_classic.csv` is extracted from the ProjectEQ dump via `tools/extract-peq.sql`
  + `tools/tsv2csv.mjs`; see `docs/building-eq_classic-csv.md`.
- `items:scrape` (`tools/build-eql-items.mjs`) walks the EQL Wiki MediaWiki API and parses each item
  page's `{{Itempage}}` template: statsblock → slot/flags, `[[Category:…]]` → type. Zones come from
  `dropsfrom` and the page's zone categories, matched against `Category:Zones` with "The …" prefix
  variants reconciled. Full run is ~10,600 items at ~8 req/s (~20 min). Flags: `--limit N` for a quick
  test, `--no-zones` to skip the zone set, `--inspect "Item Name"` to dump raw wikitext. Type
  classification is heuristic; refine `classifyType()` if a bucket looks off.
- `items:merge` (`tools/merge-ini.mjs`) reads the game's caret-format filter export and records
  `ITEM_ID` / `ICON_ID` per name: unknown names become stubs, known names get id/icon overrides.
  `--dry` previews.

## Item icons (`public/icons/`)

Real icons extracted from the EQ Legends client's `dragitem*.dds` sheets (256×256, 6×6 grid of
40×40 cells, **column-major**, icon ids start at 500). `icons:extract` converts only the sheets the
catalog references into `public/icons/dragitemN.png`, skipping ones already present. The app positions
each icon with the same math (`iconBadge` in `src/App.tsx`); items without a sheet fall back to the
lettered type dot.

## Loot-filter format

EQ Legends uses the in-game **Advanced Loot > Filters** system: per character, set each item to
**Loot / Merge / Store / Sell**. The game exports these as a caret-delimited `.ini` per character
(example: `docs/LF_Washclof_freeport.ini`). The app's import/export (`parseIni` / `buildIni` in
`src/App.tsx`) reads and writes that format, and still reads this tool's older `[Rules]` `Name=Action`
shape. Dynamic " +N" enchant suffixes are stripped so ids attach to the base item.
