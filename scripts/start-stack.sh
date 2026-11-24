#!/bin/bash
# Boots the local MagicBlock stack in the FOREGROUND (run it in its own terminal / background task):
#   client -> 6699 (QFS) -> ER 7799 -> base 8899
# Our program is preloaded from target/deploy. The ER validator identity is preloaded with
# 5 SOL (it refuses to start otherwise). Logs: ~/ed-stack.log
set -uo pipefail
. "$(dirname "$0")/env.sh"
cd "$ED_ROOT"

pkill -f 'mb-stack|mb-test-validator|ephemeral-validator|query-filtering-service|vrf-oracle' 2>/dev/null
for _ in $(seq 1 20); do
  pgrep -f 'mb-stack|mb-test-validator|ephemeral-validator|query-filtering-service' >/dev/null || break
  sleep 1
done
rm -rf ./magicblock-test-storage ./test-ledger

WALLET="$(solana-keygen pubkey "$HOME/.config/solana/id.json")"
: > "$HOME/ed-stack.log"
export RUST_LOG="${RUST_LOG:-info}"
exec mb-stack --reset \
  --account - fixtures/er-validator-funded.json \
  --upgradeable-program target/deploy/extraction_dungeon-keypair.json \
                        target/deploy/extraction_dungeon.so "$WALLET" \
  2>&1 | tee "$HOME/ed-stack.log"
