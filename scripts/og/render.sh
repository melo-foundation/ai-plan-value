#!/usr/bin/env bash
# Renders public/og.png: captures the site in Top 5 mode, then composes it into scripts/og/card.html.
# Usage: scripts/og/render.sh [chrome-binary]   (default: google-chrome, then chromium-browser)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROME="${1:-$(command -v google-chrome || command -v chromium-browser || command -v chromium)}"
PORT="${OG_PORT:-8765}"
TMP="$(mktemp -d)"
PAGE="$ROOT/public/_og_capture.html"
cleanup() { rm -f "$PAGE"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

python3 - "$ROOT/public/index.html" "$ROOT/scripts/og/inject.html" "$PAGE" <<'PY'
import sys
src, inj, out = sys.argv[1:]
html = open(src).read()
assert "</body>" in html
open(out, "w").write(html.replace("</body>", open(inj).read() + "</body>"))
PY

(cd "$ROOT/public" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) &
SERVER_PID=$!
for _ in $(seq 50); do curl -fs "http://localhost:$PORT/" >/dev/null && break; sleep 0.1; done

FLAGS=(--headless=new --no-sandbox --disable-gpu --hide-scrollbars)
"$CHROME" "${FLAGS[@]}" --virtual-time-budget=10000 --force-device-scale-factor=2 --window-size=900,560 \
  --screenshot="$TMP/site2x.png" "http://localhost:$PORT/_og_capture.html?top=5" 2>/dev/null
cp "$ROOT/scripts/og/card.html" "$TMP/card.html"
"$CHROME" "${FLAGS[@]}" --window-size=1200,630 --screenshot="$ROOT/public/og.png" "file://$TMP/card.html" 2>/dev/null
echo "Wrote $ROOT/public/og.png"
