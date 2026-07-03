<?php
// eqlfilter filter-submission drop box. The app fire-and-forgets a POST here
// when an imported .ini contains items the shipped catalog doesn't know
// (src/App.tsx maybeSubmitIni). Files pile up in the submissions dir until you
// harvest them: scp them down, then
//   node tools/merge-ini.mjs submissions/*.ini && npm run items:build
//
// Deploys via git with the rest of the repo (Forge release deploys) — nginx
// runs it straight out of the `current` symlink. SUBMIT_DIR must sit OUTSIDE
// the releases dir or Forge prunes it with old releases. Add to the site's
// nginx config, above `location /`:
//
//   location = /api/submit-ini {
//     client_max_body_size 128k;
//     include fastcgi_params;
//     fastcgi_param SCRIPT_FILENAME $site_home/current/tools/server/submit.php;
//     fastcgi_param SUBMIT_DIR      $site_home/submissions;
//     fastcgi_pass unix:/var/run/php/php8.4-fpm-eqlfilter.sock;
//   }
//
// (with `set $site_home /home/eqlfilter/eqlfilter.com;` near the top of the
// server block — match the prefix of the config's `root` directive.)
//
// No auth by design (the client is a public web page); instead: size cap,
// shape check, dedupe-by-content, and a total-files cap as a flood stop.

$DIR = $_SERVER['SUBMIT_DIR'] ?? __DIR__ . '/../../submissions';
$MAX = 128 * 1024;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }
$body = file_get_contents('php://input', false, null, 0, $MAX + 1);
if (!$body || strlen($body) > $MAX) { http_response_code(400); exit; }
// Must look like a loot filter: a caret row (ID^FILTER^ICON^NAME) or a [Rules] section.
if (!preg_match('/^\d+\^\d+\^\d+\^.+/m', $body) && stripos($body, '[rules]') === false) { http_response_code(400); exit; }

if (!is_dir($DIR) && !mkdir($DIR, 0750, true)) { http_response_code(500); exit; }
// ponytail: flood stop is a hard file cap, not rate limiting — revisit if it ever fills.
if (count(glob("$DIR/*.ini")) >= 5000) { http_response_code(429); exit; }

// Content-addressed name: re-submitting the same file is a free overwrite.
file_put_contents("$DIR/" . sha1($body) . '.ini', $body);
http_response_code(204);
