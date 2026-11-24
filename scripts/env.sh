# Vault Break - shared shell prelude.
# Source this from every script:  . "$(dirname "$0")/env.sh"
#
# Why this exists: WSL non-interactive shells do not pick up cargo/solana/avm
# from the profile, and `node` on PATH is the apt build (v18, no npm).
# Anchor shells out to `npm` during some commands, so nvm must be active.

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22.16.0 >/dev/null 2>&1

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"

export ED_ROOT="$HOME/dev/extraction_dungeon"
