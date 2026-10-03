#!/bin/sh
set -eu
umask 077
# /run is recreated by the UID:GID 10001 tmpfs mount on each container start.
# No root bootstrap, chmod of secret mounts, or browser/tunnel download is allowed.
mkdir -p /run/cgw /tmp/cgw-cache /tmp/cgw-config
exec "$@"
