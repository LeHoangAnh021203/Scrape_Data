#!/bin/bash
set -euo pipefail

if command -v apt-get >/dev/null 2>&1; then
  echo "Installing system Chromium via apt-get..."
  apt-get update
  apt-get install -y chromium-browser
else
  echo "apt-get not available; skipping system Chromium install"
fi
