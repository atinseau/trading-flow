#!/usr/bin/env bash
# Extract Claude Code OAuth credentials from the macOS Keychain into a
# project-local file consumed by the dev docker-compose stack.
#
# Idempotent: re-extracts only when the local file is missing or invalid.
# Cleans up stale empty directories that Docker may have created when
# mounting a non-existent path.
#
# Triggered automatically by `bun compose:dev` via the `precompose:dev`
# hook in package.json. Safe to run standalone any time.

set -euo pipefail

CRED_PATH="$(pwd)/.dev-claude-credentials.json"

# Fast path: existing valid creds → no-op.
if [[ -f "$CRED_PATH" && "$(head -c1 "$CRED_PATH" 2>/dev/null)" == "{" ]]; then
  echo "✓ Claude credentials cached locally (.dev-claude-credentials.json)"
  exit 0
fi

# Anything at the path that isn't a valid file (typically an empty directory
# auto-created by a previous Docker mount) gets nuked.
if [[ -e "$CRED_PATH" ]]; then
  echo "  Removing stale path at .dev-claude-credentials.json"
  rm -rf "$CRED_PATH"
fi

# macOS-only: requires the Keychain `security` binary.
if ! command -v security >/dev/null 2>&1; then
  echo "✗ 'security' command not found — this script requires macOS Keychain." >&2
  exit 1
fi

echo "Extracting Claude credentials from macOS Keychain..."
if ! creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null); then
  echo "✗ Could not extract Claude credentials from Keychain." >&2
  echo "  Is Claude Code installed and logged in? Try 'claude /login' first." >&2
  exit 1
fi

# Sanity-check the payload looks like JSON before writing.
if [[ "${creds:0:1}" != "{" ]]; then
  echo "✗ Keychain returned non-JSON content; aborting." >&2
  exit 1
fi

# Atomic-ish write + lock down perms (mounted read-only into the container).
printf '%s\n' "$creds" > "$CRED_PATH"
chmod 600 "$CRED_PATH"

echo "✓ Claude credentials written to .dev-claude-credentials.json"
