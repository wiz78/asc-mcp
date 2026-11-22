#!/bin/sh
set -eu
umask 077
ulimit -c 0
base='/Library/Application Support/ASCScoped/private'
export HOME="$base/../state"
export XDG_CONFIG_HOME="$HOME/config"
export XDG_CACHE_HOME="$HOME/cache"
export PATH=/usr/bin:/bin
IFS= read -r OP_SERVICE_ACCOUNT_TOKEN < "$base/op-token"
IFS= read -r environment_id < "$base/environment-id"
export OP_SERVICE_ACCOUNT_TOKEN
exec "$base/op" run --environment "$environment_id" -- \
  "$base/../current/node" "$base/../current/asc-daemon.mjs" "$base/apps.json" >/dev/null 2>&1
