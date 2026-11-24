#!/bin/bash
# Deploys or upgrades the program on devnet. Extends the program-data account first when the new
# binary is bigger than what's allocated. The IDL is bundled in the client, not stored on chain.
set -uo pipefail
. "$(dirname "$0")/env.sh"
cd "$ED_ROOT"
PID="$(solana-keygen pubkey target/deploy/extraction_dungeon-keypair.json)"
SO=target/deploy/extraction_dungeon.so
echo "before: $(solana balance --url devnet)"
if solana program show "$PID" --url devnet >/dev/null 2>&1; then
  HAVE=$(solana program show "$PID" --url devnet | awk '/Data Length/ {print $3}')
  NEED=$(stat -c %s "$SO")
  if [ "$NEED" -gt "$HAVE" ]; then
    EXTRA=$(( NEED - HAVE + 20000 ))
    echo "extending program data by $EXTRA bytes ($HAVE -> $((HAVE + EXTRA)))"
    solana program extend "$PID" "$EXTRA" --url devnet 2>&1 | tail -2
  fi
fi
solana program deploy "$SO" --program-id target/deploy/extraction_dungeon-keypair.json \
  --url devnet --with-compute-unit-price 10000 --max-sign-attempts 30 2>&1 | tail -4
echo "after:  $(solana balance --url devnet)"
solana program show "$PID" --url devnet 2>&1 | grep -E "Last Deployed|Data Length|Balance"
