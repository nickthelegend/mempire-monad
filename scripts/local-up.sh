#!/usr/bin/env bash
# The whole game locally, for real:
#   - anvil forking Monad testnet on :8612 (reads only — no testnet tx), chain id
#     31337, so Agora's real AUSD + faucet are there
#   - our contracts deployed with real signed transactions
#   - a real MongoDB (own mongod on :27019, data in .local/mongo)
#   - the relay on :8799 (signs live prices for the local oracle with anvil #4)
#   - the app on http://localhost:5181 (Vite, chain 31337)
#
#   ./scripts/local-up.sh            # chain + contracts + db + relay + app
#   ./scripts/local-up.sh --no-relay  # chain + contracts + db only
#   ./scripts/local-up.sh --relay-only   # restart just the relay (stop it first)
#   ./scripts/local-down.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.local"; mkdir -p "$RUN/mongo"
RPC=http://127.0.0.1:8612
FORK_URL="${FORK_URL:-https://testnet-rpc.monad.xyz}"
MNEMONIC="test test test test test test test test test test test junk"

if [ "${1:-}" != "--relay-only" ]; then
if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  anvil --port 8612 --prune-history 300 --chain-id 31337 --fork-url "$FORK_URL" --silent \
    >"$RUN/anvil.log" 2>&1 </dev/null &
  echo $! >"$RUN/anvil.pid"
  for _ in $(seq 80); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.25; done
fi
# anvil's dev accounts use a public mnemonic; on Monad testnet they carry
# EIP-7702 delegations to sweepers that forward any MON they receive, and the
# fork inherits them. Clear the code on the five we use and top them up.
for i in 0 1 2 3 4; do
  a=$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index $i)
  cast rpc anvil_setCode "$a" 0x --rpc-url $RPC >/dev/null
  [ "$(cast balance "$a" --rpc-url $RPC)" = 0 ] && cast rpc anvil_setBalance "$a" 0x21e19e0c9bab2400000 --rpc-url $RPC >/dev/null
done
echo "anvil  $RPC (fork of Monad testnet, chain $(cast chain-id --rpc-url $RPC))"

(cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url fork --broadcast --silent >/dev/null)
"$ROOT/contracts/export-abi.sh" >/dev/null
node "$ROOT/app/scripts/sync-shared.mjs" >/dev/null
(cd "$ROOT/server" && node sync-shared.mjs >/dev/null)
(cd "$ROOT/indexer" && node scripts/sync-addresses.mjs --config config.local.yaml >/dev/null 2>&1 || true)
echo "contracts → shared/deployments/31337.json"
fi

if ! lsof -iTCP:27019 -sTCP:LISTEN >/dev/null 2>&1; then
  mongod --port 27019 --bind_ip 127.0.0.1 --dbpath "$RUN/mongo" --logpath "$RUN/mongo.log" --fork >/dev/null
  lsof -ti tcp:27019 -sTCP:LISTEN | head -1 >"$RUN/mongo.pid"
fi
echo "mongo  mongodb://127.0.0.1:27019 (db mempire_local)"

if [ "${1:-}" != "--no-relay" ]; then
  (cd "$ROOT/server" && exec >/dev/null && CHAIN_ID=31337 RPC_URL=$RPC PORT=8799 PUBLIC_APP_URL=http://localhost:5181 \
    MONGODB_URI=mongodb://127.0.0.1:27019 MONGODB_DB=mempire_local \
    RELAYER_PRIVATE_KEY="$(cast wallet private-key "$MNEMONIC" 1)" \
    ORACLE_PRIVATE_KEY="$(cast wallet private-key "$MNEMONIC" 4)" \
    AUSD_FAUCET="$(jq -r .ausdFaucet "$ROOT/shared/deployments/31337.json")" \
    nohup node index.js >"$RUN/relay.log" 2>&1 </dev/null & echo $! >"$RUN/relay.pid")
  # A cold boot off a busy disk can take ~30 s.
  for _ in $(seq 240); do curl -sf localhost:8799/api/health >/dev/null && break; sleep 0.5; done
  echo "relay  http://localhost:8799"
fi

if [ "${1:-}" = "" ] && ! lsof -iTCP:5181 -sTCP:LISTEN >/dev/null 2>&1; then
  INDEXER=""; curl -sf -m 2 localhost:8090/healthz >/dev/null 2>&1 && INDEXER=http://localhost:8090/v1/graphql
  (cd "$ROOT/app" && exec >/dev/null && PORT=5181 VITE_CHAIN_ID=31337 VITE_API_URL=http://localhost:8799 \
    VITE_INDEXER_URL="$INDEXER" nohup npx vite --host 127.0.0.1 >"$RUN/vite.log" 2>&1 </dev/null & echo $! >"$RUN/vite.pid")
  for _ in $(seq 120); do curl -sf localhost:5181 >/dev/null && break; sleep 0.5; done
  echo "app    http://localhost:5181${INDEXER:+  (indexer $INDEXER)}"
fi
