#!/bin/bash
. "$(dirname "$0")/../scripts/env.sh"
cd "$(dirname "$0")"
exec npx vite --host 0.0.0.0 --port 5180 --strictPort
