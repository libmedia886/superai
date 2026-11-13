#!/bin/sh
# {{ managed_marker }}
set -eu

directory=$SUPERAI_HOME
if [ -n "${SUPERAI_ENV_FILE:-}" ] && [ -f "$SUPERAI_ENV_FILE" ]; then
    set -a
    . "$SUPERAI_ENV_FILE"
    set +a
fi

export SUPERAI_HOME="$directory"
exec "$SUPERAI_PYTHON" "$SUPERAI_SUPERVISOR" --executable "$SUPERAI_EXECUTABLE" --config "$SUPERAI_CONFIG"
