#!/usr/bin/env bash
# The whole game on a local chain: anvil on :8611 (pruned), mock Pyth / AUSD /
# AUSD faucet, the four game contracts, and the addresses fanned out to the app,
# relay and indexer. No testnet, no keys, nothing hosted.
#
#   ./scripts/local-up.sh            # chain + contracts
#   ./scripts/local-up.sh --relay    # …and the relay on :8799 (mock Pyth prices)
#   ./scripts/local-down.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.local"; mkdir -p "$RUN"
RPC=http://127.0.0.1:8611

if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  anvil --port 8611 --prune-history 300 --chain-id 31337 --silent >"$RUN/anvil.log" 2>&1 </dev/null &
  echo $! >"$RUN/anvil.pid"
  for _ in $(seq 40); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.25; done
fi
echo "anvil  $RPC (chain $(cast chain-id --rpc-url $RPC))"

(cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url local --broadcast --silent >/dev/null)
"$ROOT/contracts/export-abi.sh" >/dev/null
node "$ROOT/app/scripts/sync-shared.mjs" >/dev/null
(cd "$ROOT/server" && node sync-shared.mjs >/dev/null 2>&1 || npm run --silent sync-shared >/dev/null)
echo "contracts → shared/deployments/31337.json"
jq -r 'to_entries[] | select(.key|test("token|cards|arena|marketMeta|ausd|pyth")) | "  \(.key)\t\(.value)"' "$ROOT/shared/deployments/31337.json"

if [ "${1:-}" = "--relay" ]; then
  (cd "$ROOT/server" && exec >/dev/null && CHAIN_ID=31337 RPC_URL=$RPC PORT=8799 PUBLIC_APP_URL=http://localhost:5181 \
    RELAYER_PRIVATE_KEY="$(cast wallet private-key 'test test test test test test test test test test test junk' 1)" \
    AUSD_FAUCET="$(jq -r .ausdFaucet "$ROOT/shared/deployments/31337.json")" \
    nohup node index.js >"$RUN/relay.log" 2>&1 </dev/null & echo $! >"$RUN/relay.pid")
  for _ in $(seq 40); do curl -sf localhost:8799/api/health >/dev/null && break; sleep 0.25; done
  echo "relay  http://localhost:8799"
fi
