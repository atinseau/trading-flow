#!/bin/sh
# Connect to a running trading-flow container deployed via Coolify,
# or to the remote host itself with --host.
#
# Usage: ./scripts/remote-shell.sh [--host | --list | <container> [command...]]
#
# Examples:
#   ./scripts/remote-shell.sh --list                       # list tf-* containers on host
#   ./scripts/remote-shell.sh web                          # interactive shell in tf-web
#   ./scripts/remote-shell.sh postgres                     # interactive shell in tf-postgres
#   ./scripts/remote-shell.sh postgres psql -U trading_flow -d trading_flow
#   ./scripts/remote-shell.sh analysis-worker tail -f /tmp/app.log
#   ./scripts/remote-shell.sh --host                       # interactive shell on remote host
#   ./scripts/remote-shell.sh --host uptime                # run a single command on remote host

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$PROJECT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  REMOTE=$(grep -E '^REMOTE=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi

if [ -z "$REMOTE" ]; then
  echo "Error: REMOTE is not set in .env file." >&2
  exit 1
fi

# All trading-flow containers are prefixed with `tf-` (see docker-compose.yml).
PREFIX="tf-"

list_containers() {
  ssh "$REMOTE" "sudo docker ps --format '{{.Names}}\t{{.Status}}' | grep '^${PREFIX}'"
}

if [ "$1" = "--list" ]; then
  list_containers
  exit 0
fi

if [ "$1" = "--host" ]; then
  shift
  if [ $# -eq 0 ]; then
    exec ssh -t "$REMOTE"
  else
    exec ssh "$REMOTE" "$*"
  fi
fi

if [ $# -eq 0 ]; then
  echo "Usage: $0 [--host | --list | <container> [command...]]" >&2
  echo "" >&2
  echo "Available containers on $REMOTE:" >&2
  list_containers >&2
  exit 1
fi

TARGET=$1
shift

# Resolve the container name. Try in order:
#   1. exact match on `tf-<TARGET>`
#   2. exact match on `<TARGET>` (in case the user passed the full name)
#   3. substring match on any `tf-*` container
NAMES=$(ssh "$REMOTE" "sudo docker ps --format '{{.Names}}' | grep '^${PREFIX}'" 2>/dev/null)

if [ -z "$NAMES" ]; then
  echo "Error: no '${PREFIX}*' containers running on $REMOTE." >&2
  exit 1
fi

CONTAINER=$(echo "$NAMES" | grep -Fx "${PREFIX}${TARGET}" | head -1)
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(echo "$NAMES" | grep -Fx "$TARGET" | head -1)
fi
if [ -z "$CONTAINER" ]; then
  MATCHES=$(echo "$NAMES" | grep -F "$TARGET")
  COUNT=$(echo "$MATCHES" | grep -c .)
  if [ "$COUNT" -eq 1 ]; then
    CONTAINER=$MATCHES
  elif [ "$COUNT" -gt 1 ]; then
    echo "Error: '$TARGET' matches multiple containers:" >&2
    echo "$MATCHES" >&2
    exit 1
  fi
fi

if [ -z "$CONTAINER" ]; then
  echo "Error: no container matching '$TARGET' on $REMOTE." >&2
  echo "Available:" >&2
  echo "$NAMES" >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  # Interactive shell — try bash first, fall back to sh (alpine/distroless-friendly).
  exec ssh -t "$REMOTE" "sudo docker exec -it '$CONTAINER' /bin/sh -c 'command -v bash >/dev/null && exec bash || exec sh'"
else
  exec ssh "$REMOTE" "sudo docker exec '$CONTAINER' $*"
fi
