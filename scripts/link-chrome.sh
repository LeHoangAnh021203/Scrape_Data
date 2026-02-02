#!/bin/bash
set -euo pipefail

TARGET="/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome"
LINK="/opt/render/.cache/puppeteer/bin/chrome"

mkdir -p "$(dirname "$LINK")"
ls -l "/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/"
chmod +x "$TARGET"
ln -sf "$TARGET" "$LINK"
ls -l "$(dirname "$LINK")"
echo "linked chrome: $TARGET -> $LINK"
