#!/bin/sh
# Runs test/anchor.test.html in headless Chrome and prints the #result block.
DIR="$(cd "$(dirname "$0")" && pwd)"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --user-data-dir="$(mktemp -d)" --allow-file-access-from-files --virtual-time-budget=3000 \
  --dump-dom "file://$DIR/anchor.test.html" 2>/dev/null \
  | sed -n '/<pre id="result">/,/<\/pre>/p' | sed 's/<[^>]*>//g'
