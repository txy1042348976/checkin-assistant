#!/bin/sh
set -eu

# A host bind mount initially belongs to the host. Fix it before dropping privileges.
# Node and its background task browsers then run as the image's node uid 1000.
if [ "$(id -u)" = "0" ]; then
    mkdir -p "${CHECKIN_DATA_DIR:-/data}"
    chown -R node:node "${CHECKIN_DATA_DIR:-/data}"
    chmod 700 "${CHECKIN_DATA_DIR:-/data}"
    # Preserve file modes, including an existing private secret.key (0600).
    exec gosu node "$@"
fi

exec "$@"
