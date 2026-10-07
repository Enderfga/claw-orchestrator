#!/bin/bash
# Five engines in parallel, three takes each in sequence, first attempt only.
# Needs a running `clawo serve`; DEMO is where the repos and results go.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
DEMO=${DEMO:-$PWD/demo}
mkdir -p "$DEMO/json/hero" "$DEMO/repos"
for e in claude codex agy grok opencode; do (
  for k in 1 2 3; do
    "$HERE/make_repo.sh" "$DEMO/repos/$e-$k"
    cd "$DEMO/repos/$e-$k"
    clawo solve "The test fails. Fix price.js." -e $e --max-repairs 0 \
      -c "node --test" -c "node $HERE/holdout/price.holdout.mjs" --wait --json > "$DEMO/json/hero/$e-$k.json"
    echo "$e-$k exit=$?"
  done ) & done
wait
