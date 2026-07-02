#!/usr/bin/env node
// Convert tab-separated rows on stdin to RFC4180 CSV on stdout, prepending the eq_classic.csv
// header. Used to materialize tools/extract-peq.sql's output into eq_classic.csv:
//
//   mariadb -u root -p peq -N < tools/extract-peq.sql | node tools/tsv2csv.mjs > eq_classic.csv
//
// PEQ item names contain commas and apostrophes (and `--no-default` mariadb -N gives us a clean
// tab dump with no quoting), so we quote any field with a comma/quote/newline, doubling quotes.
// Safe because no PEQ item name contains a tab or newline (checked).

let buf = ''
process.stdin.on('data', d => buf += d)
process.stdin.on('end', () => {
  const q = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  const rows = buf.replace(/\n$/, '').split('\n').map(l => l.split('\t').map(q).join(','))
  process.stdout.write('id,name,item_type,slot,zones,no_drop,lore,magic,quest,icon_id\n' + rows.join('\n') + '\n')
})
