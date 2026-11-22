#!/bin/bash
set -euo pipefail
umask 077
base='/Library/Application Support/ASCScoped'
source_dir="$(cd "$(dirname "$0")" && pwd -P)"
[[ $EUID == 0 && -d "$base/private" && -f "$base/install-manifest.json" ]] || { echo 'Run with sudo after installing or explicitly adopting a legacy installation.' >&2; exit 1; }
source "$source_dir/action-lock.sh"
trap action_lock_release EXIT
action_lock_acquire
staging="$(mktemp -d "$base/.op-repair.XXXXXXXX")"
stopped=false; replaced=false; completed=false
cleanup() {
 local status=$? keep_staging=false
 set +e
 if [[ "$completed" != true ]]; then
  if [[ "$replaced" == true ]]; then
   if ! mv -f "$staging/previous-op" "$base/private/op"; then
    keep_staging=true
    echo "Could not restore previous op binary; recovery copy retained at $staging/previous-op" >&2
   fi
  fi
  if [[ "$stopped" == true ]]; then
   launchctl bootstrap system /Library/LaunchDaemons/local.asc-scoped.plist || echo 'Could not restore daemon registration after repair failure.' >&2
  fi
 fi
 [[ "$keep_staging" == true ]] || rm -rf "$staging"
 action_lock_release
 exit "$status"
}
trap cleanup EXIT
/bin/bash "$source_dir/stage-op.sh" "$staging/op" "${1:-$(command -v op || true)}"
chown root:wheel "$staging/op"
# Make the recovery copy before disrupting the registered job.
cp -p "$base/private/op" "$staging/previous-op"
if launchctl print system/local.asc-scoped >/dev/null 2>&1; then
 launchctl bootout system/local.asc-scoped
 stopped=true
fi
mv -f "$staging/op" "$base/private/op"
replaced=true
launchctl bootstrap system /Library/LaunchDaemons/local.asc-scoped.plist
completed=true
