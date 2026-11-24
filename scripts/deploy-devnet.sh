#!/bin/bash
# Deploys (or upgrades) the program on devnet. The IDL is bundled in the client, not stored on chain.
set -uo pipefail
. "$(dirname "$0")/env.sh"
cd "$ED_ROOT"
echo "before: $(solana balance --url devnet)"
solana program deploy target/deploy/extraction_dungeon.so \
  --program-id target/deploy/extraction_dungeon-keypair.json \
  --url devnet --with-compute-unit-price 10000 --max-sign-attempts 30 2>&1 | tail -5
echo "after:  $(solana balance --url devnet)"
solana program show "$(solana-keygen pubkey target/deploy/extraction_dungeon-keypair.json)" --url devnet 2>&1 | head -8
