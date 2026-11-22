#!/bin/bash
# Standalone: requires only macOS system tools, never Node or this checkout.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
helper_dir="$(cd "$(dirname "$0")" && pwd -P)"
source "$helper_dir/manifest-utils.sh"
base='/Library/Application Support/ASCScoped'
plist='/Library/LaunchDaemons/local.asc-scoped.plist'
manifest="$base/install-manifest.json"
[[ $EUID == 0 && "$(uname -s)" == Darwin ]] || { echo 'Run the uninstaller with sudo on macOS.' >&2; exit 1; }
source "$helper_dir/action-lock.sh"
trap action_lock_release EXIT
action_lock_acquire
# Every ancestor is administrator controlled; no symlink manifest/base allowed.
[[ -f "$manifest" && ! -L "$manifest" && ! -L "$base" ]] || exit 1
check_path="$manifest"
while :; do
 [[ ! -L "$check_path" && "$(stat -f %u "$check_path")" == 0 && $((8#$(stat -f %Lp "$check_path") & 8#22)) == 0 ]] || { echo 'Untrusted manifest path; refusing removal.' >&2; exit 1; }
 [[ "$check_path" == / ]] && break
 check_path="$(dirname "$check_path")"
done
manifest_validate "$manifest" || { echo 'Invalid installation manifest; refusing removal.' >&2; exit 1; }
owner_client="$(manifest_value "$manifest" client string)"
owned_user="$(manifest_value "$manifest" createdUser bool)"
owned_group="$(manifest_value "$manifest" createdGroup bool)"
membership="$(manifest_value "$manifest" addedMembership bool)"
if launchctl print system/local.asc-scoped >/dev/null 2>&1; then
 launchctl bootout system/local.asc-scoped
fi
rm -f "$plist"
if [[ "$membership" == true ]] && dseditgroup -o checkmember -m "$owner_client" ascclients >/dev/null 2>&1; then
 dseditgroup -o edit -d "$owner_client" -t user ascclients
fi
if [[ "$owned_group" == true ]] && dscl . -read /Groups/ascclients >/dev/null 2>&1; then
 dseditgroup -o delete ascclients
fi
if [[ "$owned_user" == true ]] && dscl . -read /Users/ascdaemon >/dev/null 2>&1; then
 dscl . -delete /Users/ascdaemon
fi
# This also removes this installed helper and all installation-owned state.
rm -rf "$base"
echo 'Removed installation, credentials, socket, releases and installer-owned accounts/membership.'
