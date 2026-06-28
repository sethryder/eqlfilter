# Building `eq_classic.csv` from the ProjectEQ dump

`eq_classic.csv` is the **classic item base** for the catalog pipeline. The README documents
everything *downstream* of it (`items:import` → `items:build` → `public/eql-items.json`). This doc
covers the one step the README treats as a given: **where `eq_classic.csv` comes from and how to
regenerate it** from the EQEmulator (ProjectEQ) content database.

It's a one-query extraction, now captured as a committed, verified script — no more guesswork.

- `tools/extract-peq.sql` — the extraction query (decode tables + joins live here)
- `tools/tsv2csv.mjs` — turns the query output into the RFC4180 CSV the importer expects

## What the CSV is

One row per item that **drops in at least one Classic-era zone** (`zone.expansion = 0`). That
loot-driven filter is what makes it "classic": ~4,300 items out of the dump's ~118,000, each with the
list of classic zones it drops in. Items that don't drop in a classic zone are simply absent (the
loot join excludes them). Keyed by item `id` — **not** deduped by name (a few hundred names repeat
across ids; the downstream `items:import` is what dedupes by name).

Columns: `id, name, item_type, slot, zones, no_drop, lore, magic, quest, icon_id`
(`zones` is ` | `-delimited; flags are `1` = set; see the decode notes below).

## Source data

The ProjectEQ content dump — a zip of `mariadb-dump` SQL:

    https://db.eqemu.dev/api/v1/dump/latest

Inside the zip is `create_tables_content.sql` (~270 MB unzipped, ~70 tables). We only need five:

    items   lootdrop   lootdrop_entries   loottable   loottable_entries

…plus the zone/spawn tables (`zone`, `spawn2`, `spawnentry`, `spawngroup`, `npc_types`) that drive
the zone derivation. The sibling **nta** project (`~/dev/nta`) already imports the zone/spawn set
into a `peq` MariaDB via `php artisan eq:import-peq`, but its `config/eqrouter.php` `import_tables`
list **omits `items` and the loot tables** (the router doesn't need them) — so for this extraction
you load those five yourself on top.

## Regenerate, end to end

Assumes a MariaDB with the zone/spawn tables already present (e.g. nta's `peq` DB after
`eq:import-peq`). If starting clean, also load `zone`, `spawn2`, `spawnentry`, `spawngroup`,
`npc_types` from the same dump.

```sh
# 1. Get + unzip the dump.
curl -L https://db.eqemu.dev/api/v1/dump/latest -o peq-dump.zip
unzip -o peq-dump.zip '*create_tables_content.sql'

# 2. Slice out items + the four loot tables (the full file is too big to load whole).
#    Captures each table's section from its "-- Table structure" marker to the next.
awk 'BEGIN{RS="-- Table structure for table `"}
     {n=$0; sub(/`.*/,"",n)}
     n=="items"||n=="lootdrop"||n=="lootdrop_entries"||n=="loottable"||n=="loottable_entries"{
       printf "-- Table structure for table `%s", $0}' \
    peq-dump/create_tables_content.sql > item_loot.sql

# 3. Load them (FK checks off — loot rows reference items/npcs in any order).
{ echo "SET FOREIGN_KEY_CHECKS=0;"; cat item_loot.sql; } | mariadb -u root -p peq

# 4. Extract -> CSV.
mariadb -u root -p peq -N < tools/extract-peq.sql | node tools/tsv2csv.mjs > eq_classic.csv
```

Then run the normal pipeline (see README): `npm run items:import && npm run items:build`.

> The nta project loads its DB in Docker; there you'd pipe through the container, e.g.
> `docker exec -i nta-mariadb-1 mariadb -u root -ppassword peq -N < tools/extract-peq.sql | …`

## How the columns are derived

All of this is encoded in `tools/extract-peq.sql`; the notes here explain the non-obvious bits.

**`item_type`** — decoded from `items.itemtype` (an int). The `CASE` covers every value that occurs
in the classic set; unlisted values fall through to `Misc`. These strings are the *raw EQEMU type
names* — `import-eqemu.mjs` is what later buckets them into the 6 app categories (Weapon/Armor/
Jewelry/Tradeskill/Container/Misc), so keep them verbatim.

**`slot`** — decoded from the `items.slots` bitmask, in slot order, `, `-joined. Paired bits collapse
to one label: Ear (`2|16`), Wrist (`512|1024`), Finger (`32768|65536`). Empty when not equippable.

| bit | slot | bit | slot | bit | slot |
|----:|------|----:|------|----:|------|
| 1 | Charm | 256 | Back | 65536 | Finger |
| 2 / 16 | Ear | 512 / 1024 | Wrist | 131072 | Chest |
| 4 | Head | 2048 | Range | 262144 | Legs |
| 8 | Face | 4096 | Hands | 524288 | Feet |
| 32 | Neck | 8192 | Primary | 1048576 | Waist |
| 64 | Shoulders | 16384 | Secondary | 2097152 | Power Source |
| 128 | Arms | 32768 | Finger | 4194304 | Ammo |

**`zones`** — the heart of the "classic" filter. There's no item→zone column; it's the loot chain:

    items.id
      → lootdrop_entries.item_id        (.lootdrop_id)
      → loottable_entries.lootdrop_id   (.loottable_id)
      → npc_types.loottable_id          (npc that carries the table)
      → spawnentry.npcID                (.spawngroupID)
      → spawn2.spawngroupID             (.zone = zone short name)
      → zone.short_name                 (filtered to expansion = 0 → zone.long_name)

`INNER JOIN`s throughout, so an item with no classic drop produces no rows and is excluded.

**Flags** (`1` = set):
- `no_drop` = `items.nodrop = 0`. **EQEMU's `nodrop` is inverted** — `0` means the item *cannot* be
  dropped/traded ("NO DROP"); non-zero means freely tradable. We flip it to the intuitive sense.
- `lore` = `items.loregroup <> 0` (item belongs to a lore group).
- `magic` = `items.magic` (already 0/1).
- `quest` = `items.questitemflag`.
- `icon_id` = `items.icon` (icons live in `dragitem*.dds`, ids ≥ 500; see README "Item icons").

## Verification & caveats

- Verified against the shipped `eq_classic.csv`: the regenerated rows match **byte-for-byte** for
  every shared id (item 1001 *Cloth Cap*, quoted-name rows, weapons, no-drop items all confirmed).
- The shipped CSV and a fresh extraction differ only by **dump version drift** — loot tables change
  between snapshots, so a newer dump shuffles a handful of items in/out of the classic set (~0.8% on
  the snapshot tested). This is expected, not a bug in the query.
- `tsv2csv.mjs` relies on no item name containing a tab or newline (checked true); commas and
  apostrophes are common and handled by RFC4180 quoting, matching `import-eqemu.mjs`'s parser.
