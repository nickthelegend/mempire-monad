#!/usr/bin/env bash
# Stop what local-up started — by PID only (other sessions share this machine).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for p in relay anvil mongo vite; do
  f="$ROOT/.local/$p.pid"
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null && echo "stopped $p"
  rm -f "$f"
done
