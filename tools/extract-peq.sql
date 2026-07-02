-- Extract the classic item catalog from a ProjectEQ content dump -> eq_classic.csv columns.
-- Run against a MariaDB/MySQL holding the PEQ `items` + loot + spawn + zone tables (see
-- docs/building-eq_classic-csv.md for how to load them). Emits one row per item that drops in
-- at least one Classic-era zone (zone.expansion = 0). Verified to reproduce eq_classic.csv
-- byte-for-byte for shared rows; the only deltas come from using a different dump snapshot.
--
-- Decode tables (itemtype, slots bitmask) and flag normalization are inline below — they ARE the
-- contract the downstream importer (tools/import-eqemu.mjs) expects.

-- Zone lists routinely exceed the legacy 1024-byte GROUP_CONCAT default (MySQL 5.x /
-- older MariaDB), which truncates silently — raise it for this session.
SET SESSION group_concat_max_len = 65536;

SELECT
  i.id,
  i.Name AS name,
  -- EQEMU items.itemtype (int) -> the type strings import-eqemu.mjs buckets into 6 categories.
  -- Only the values that occur in the Classic set are listed; anything else falls through to Misc.
  CASE i.itemtype
    WHEN 0 THEN '1H Slashing' WHEN 1 THEN '2H Slashing' WHEN 2 THEN '1H Piercing'
    WHEN 3 THEN '1H Blunt' WHEN 4 THEN '2H Blunt' WHEN 5 THEN 'Bow'
    WHEN 7 THEN 'Throwing' WHEN 8 THEN 'Shield' WHEN 10 THEN 'Armor'
    WHEN 11 THEN 'Misc' WHEN 14 THEN 'Food' WHEN 15 THEN 'Drink'
    WHEN 16 THEN 'Light Source' WHEN 17 THEN 'Tradeskill' WHEN 18 THEN 'Bandage'
    WHEN 19 THEN 'Throwing' WHEN 20 THEN 'Spell Scroll' WHEN 21 THEN 'Potion'
    WHEN 23 THEN 'Wind Instrument' WHEN 24 THEN 'Stringed Instrument'
    WHEN 25 THEN 'Brass Instrument' WHEN 26 THEN 'Percussion Instrument'
    WHEN 27 THEN 'Arrow' WHEN 29 THEN 'Jewelry' WHEN 31 THEN 'Book'
    WHEN 32 THEN 'Note' WHEN 33 THEN 'Key' WHEN 34 THEN 'Coin'
    WHEN 35 THEN '2H Piercing' WHEN 36 THEN 'Fishing Pole' WHEN 37 THEN 'Fishing Bait'
    WHEN 38 THEN 'Alcohol' WHEN 39 THEN 'Key' WHEN 42 THEN 'Poison'
    WHEN 45 THEN 'Hand to Hand' WHEN 54 THEN 'Augmentation' WHEN 69 THEN 'Mask'
    ELSE 'Misc'
  END AS item_type,
  -- EQEMU items.slots is a bitmask of equip slots. Paired bits (Ear 2|16, Wrist 512|1024,
  -- Finger 32768|65536) collapse to one label. Empty string when the item isn't equippable —
  -- NOT NULL: batch-mode mariadb prints NULL as the literal string "NULL", which would flow
  -- through tsv2csv into the catalog as slot:"NULL". CONCAT_WS already yields '' when every
  -- arg is NULL.
  CONCAT_WS(', ',
    IF(i.slots & 1,             'Charm',        NULL),
    IF(i.slots & (2|16),        'Ear',          NULL),
    IF(i.slots & 4,             'Head',         NULL),
    IF(i.slots & 8,             'Face',         NULL),
    IF(i.slots & 32,            'Neck',         NULL),
    IF(i.slots & 64,            'Shoulders',    NULL),
    IF(i.slots & 128,           'Arms',         NULL),
    IF(i.slots & 256,           'Back',         NULL),
    IF(i.slots & (512|1024),    'Wrist',        NULL),
    IF(i.slots & 2048,          'Range',        NULL),
    IF(i.slots & 4096,          'Hands',        NULL),
    IF(i.slots & 8192,          'Primary',      NULL),
    IF(i.slots & 16384,         'Secondary',    NULL),
    IF(i.slots & (32768|65536), 'Finger',       NULL),
    IF(i.slots & 131072,        'Chest',        NULL),
    IF(i.slots & 262144,        'Legs',         NULL),
    IF(i.slots & 524288,        'Feet',         NULL),
    IF(i.slots & 1048576,       'Waist',        NULL),
    IF(i.slots & 2097152,       'Power Source', NULL),
    IF(i.slots & 4194304,       'Ammo',         NULL)
  ) AS slot,
  -- Distinct Classic zones this item drops in, sorted, ' | '-joined. Needs the raised
  -- group_concat_max_len below — common drops exceed the legacy 1024 default and would
  -- truncate mid-zone-name.
  GROUP_CONCAT(DISTINCT z.long_name ORDER BY z.long_name SEPARATOR ' | ') AS zones,
  -- Flags normalized to 1 = set. NOTE: EQEMU items.nodrop is INVERTED (0 = cannot be dropped/
  -- traded = "NO DROP"; non-zero = freely tradable), so we flip it here. lore = has a lore group.
  IF(i.nodrop = 0, 1, 0)      AS no_drop,
  IF(i.loregroup <> 0, 1, 0)  AS lore,
  i.magic                     AS magic,
  i.questitemflag             AS quest,
  i.icon                      AS icon_id
FROM items i
JOIN lootdrop_entries  lde ON lde.item_id      = i.id
JOIN loottable_entries lte ON lte.lootdrop_id  = lde.lootdrop_id
JOIN npc_types         n   ON n.loottable_id   = lte.loottable_id
JOIN spawnentry        se  ON se.npcID         = n.id
JOIN spawn2            s2  ON s2.spawngroupID  = se.spawngroupID
JOIN zone              z   ON z.short_name = s2.zone AND z.expansion = 0  -- Classic only
GROUP BY i.id
ORDER BY i.id;
