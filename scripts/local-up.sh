#!/usr/bin/env bash
# The whole game locally, for real:
#   - anvil forking Monad testnet on :8612 (reads only — no testnet tx), chain id
#     31337, so Agora's real AUSD + faucet are there
#   - our contracts deployed with real signed transactions
#   - a real MongoDB (own mongod on :27019, data in .local/mongo)
#   - the relay on :8799 (signs live prices for the local oracle with anvil #4)
#
#   ./scripts/local-up.sh            # chain + contracts + db + relay
#   ./scripts/local-up.sh --no-relay
#   ./scripts/local-down.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.local"; mkdir -p "$RUN/mongo"
RPC=http://127.0.0.1:8612
FORK_URL="${FORK_URL:-https://testnet-rpc.monad.xyz}"
MNEMONIC="test test test test test test test test test test test junk"

if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  anvil --port 8612 --prune-history 300 --chain-id 31337 --fork-url "$FORK_URL" --silent \
    >"$RUN/anvil.log" 2>&1 </dev/null &
  echo $! >"$RUN/anvil.pid"
  for _ in $(seq 80); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.25; done
fi
echo "anvil  $RPC (fork of Monad testnet, chain $(cast chain-id --rpc-url $RPC))"

(cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url fork --broadcast --silent >/dev/null)
"$ROOT/contracts/export-abi.sh" >/dev/null
node "$ROOT/app/scripts/sync-shared.mjs" >/dev/null
(cd "$ROOT/server" && node sync-shared.mjs >/dev/null)
(cd "$ROOT/indexer" && node scripts/sync-addresses.mjs --config config.local.yaml >/dev/null 2>&1 || true)
echo "contracts → shared/deployments/31337.json"

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
  for _ in $(seq 60); do curl -sf localhost:8799/api/health >/dev/null && break; sleep 0.25; done
  echo "relay  http://localhost:8799"
fi
