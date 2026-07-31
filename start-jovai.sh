#!/usr/bin/env bash
# Dev launcher with JovAI branding — start.sh with VITE_LIT_BRAND=jovai.
# The brand only changes the webview (title, wordmark, welcome text); the
# backend, data dir, and everything else are identical to start.sh, so your
# channels/apps/agents all appear as normal. For JovAI-branded screenshots.
set -euo pipefail
cd "$(dirname "$0")"
export VITE_LIT_BRAND=jovai
exec ./start.sh "$@"
