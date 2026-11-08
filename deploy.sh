#!/bin/bash
# One command: typecheck, bump the build tag, cache-bust the bundle, publish.
set -e
cd "$(dirname "$0")"
TAG=$(date -u +%Y%m%d.%H%M%S)
./node_modules/.bin/esbuild src/main.ts --bundle --outfile=dist/game.js --format=iife --target=es2020 --log-level=error
printf '{"build":"%s"}\n' "$TAG" > dist/version.json
python3 - "$TAG" <<'PY'
import re, sys
tag = sys.argv[1]
s = open('index.html').read()
s = re.sub(r'dist/game\.js(\?v=[A-Za-z0-9._-]*)?', f'dist/game.js?v={tag}', s)
s = re.sub(r'var BUILD = "[^"]*"', f'var BUILD = "{tag}"', s)
open('index.html', 'w').write(s)
PY
echo "built $TAG"
