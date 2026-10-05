#!/usr/bin/env bash
# Stop whatever local-up started.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for p in relay anvil; do
  f="$ROOT/.local/$p.pid"
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null && echo "stopped $p"
  rm -f "$f"
done
