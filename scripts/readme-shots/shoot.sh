#!/usr/bin/env bash
# Regenerates the README screenshots from harness.html with headless Chrome.
# Usage: npm run build && scripts/readme-shots/shoot.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
out="$repo/docs/images"
mkdir -p "$out"

"$chrome" --headless=new --disable-gpu --hide-scrollbars \
  --allow-file-access-from-files \
  --force-device-scale-factor=2 \
  --window-size=400,860 \
  --virtual-time-budget=2000 \
  --screenshot="$out/sidebar.png" \
  "file://$here/harness.html"

echo "Wrote $out/sidebar.png"
