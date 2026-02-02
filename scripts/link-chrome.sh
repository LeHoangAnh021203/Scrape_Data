#!/bin/bash
set -euo pipefail

TARGET="/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome"
LINK="/opt/render/.cache/puppeteer/bin/chrome"

mkdir -p "$(dirname "$LINK")"
ln -sf "$TARGET" "$LINK"
