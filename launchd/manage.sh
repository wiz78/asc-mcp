#!/bin/bash
# Deployment source only: never source this file from a credentialed process.
set -euo pipefail
umask 077
# macOS enforces symlink permissions during realpath resolution. Release links
# contain public code paths; keep them traversable without relaxing file modes.
ln() { (umask 022; command ln "$@"); }
source_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
action="${1:?install, update, rollback or uninstall}"; shift
if [[ "$action" == uninstall ]]; then
 exec /bin/bash "$source_dir/launchd/uninstall-owned.sh" "$@"
fi
node_path="$(command -v node || true)"; op_path="$(command -v op || true)"
PATH=/usr/bin:/bin:/usr/sbin:/sbin
base='/Library/Application Support/ASCScoped'
plist='/Library/LaunchDaemons/local.asc-scoped.plist'
client="${SUDO_USER:-}"; config=''; create_user=false; adopt_legacy=false
while (($#)); do
 case "$1" in
 --create-service-user) create_user=true; shift;;
 --adopt-legacy) adopt_legacy=true; shift;;
 --node) node_path="${2:?Node path required}"; shift 2;;
 --op) op_path="${2:?1Password path required}"; shift 2;;
 --client) client="${2:?Local account required}"; shift 2;;
 --config) config="${2:?Configuration required}"; shift 2;;
 --*) echo "Unknown option: $1" >&2; exit 1;;
 *) [[ -z "$config" ]] || { echo 'Only one configuration may be passed.' >&2; exit 1; }; config="$1"; shift;;
 esac
done
fail() { echo "$*" >&2; exit 1; }
warn() { echo "Warning: $*" >&2; }
[[ $EUID == 0 ]] || fail 'Run this deployment script with sudo in your own Terminal.'
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'This preview supports native Apple Silicon macOS only.'
case "$action" in install|update|rollback|uninstall) ;; *) fail 'Unknown deployment action.';; esac
source "$source_dir/launchd/action-lock.sh"
trap action_lock_release EXIT
action_lock_acquire
# Resolve symlinks without executing the candidate runtime, then inspect all ancestors.
resolve() { local p="$1" d; while [[ -L "$p" ]]; do d="$(dirname "$p")"; p="$(readlink "$p")"; [[ "$p" == /* ]] || p="$d/$p"; done; (cd "$(dirname "$p")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$p")"); }
trusted() {
 local p; p="$(resolve "$1")" || return 1
 while :; do
  [[ "$(stat -f %u "$p")" == 0 ]] || return 1
  [[ $(( 8#$(stat -f %Lp "$p") & 8#22 )) == 0 ]] || return 1
  [[ "$p" == / ]] && break; p="$(dirname "$p")"
 done
}
validate_node() {
 [[ -n "$node_path" && "$node_path" == /* && -x "$node_path" ]] || fail 'Pass an existing executable Node path with --node /absolute/path/to/node.'
 node_path="$(resolve "$node_path")" || fail 'Cannot resolve the Node executable path.'
 trusted "$node_path" || warn 'Node or its parent directories are not root-owned/protected. Anyone who can replace the runtime can affect daemon credential isolation.'
 local info version architecture
 if ! info="$("$node_path" -p 'process.versions.node + " " + process.arch' 2>/dev/null)"; then
  warn 'Cannot determine Node version/architecture. Continuing to deployment validation.'
  return 0
 fi
 read -r version architecture <<< "$info"
 [[ "$version" == 24.* ]] || warn "Node $version is outside the tested Node.js 24 series; continuing."
 [[ "$architecture" == arm64 ]] || warn "Node architecture $architecture differs from the tested arm64 runtime; continuing."
 return 0
}
validate_node
manifest="$base/install-manifest.json"
validate_manifest() {
 [[ -f "$manifest" && ! -L "$manifest" ]] && trusted "$manifest" || fail 'No trusted installation manifest. Legacy installations require the documented explicit migration.'
 "$node_path" --input-type=module - "$manifest" "$source_dir/launchd/install-plan.mjs" <<'JS'
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const {uninstallPlan}=await import(pathToFileURL(process.argv[3]));uninstallPlan(JSON.parse(readFileSync(process.argv[2])));
JS
}
manifest_field() { "$node_path" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]]))' "$manifest" "$1"; }
set_field() { "$node_path" -e 'const fs=require("fs"),p=process.argv[1],m=JSON.parse(fs.readFileSync(p));m[process.argv[2]]=process.argv[3]==="true";const next=p+".next";fs.writeFileSync(next,JSON.stringify(m,null,2)+"\n",{mode:0o600,flag:"wx"});fs.renameSync(next,p)' "$manifest" "$1" "$2"; }
journal_mutation() {
 local flag="$1"; shift
 set_field "$flag" true || return 1
 "$@"
}
remove_owned() {
 (validate_manifest) || return 1
 local owned_user owned_group membership owner_client
 owned_user="$(manifest_field createdUser)"; owned_group="$(manifest_field createdGroup)"; membership="$(manifest_field addedMembership)"; owner_client="$(manifest_field client)"
 if launchctl print system/local.asc-scoped >/dev/null 2>&1; then launchctl bootout system/local.asc-scoped || return 1; fi
 rm -f "$plist" || return 1
 if [[ "$membership" == true ]] && dseditgroup -o checkmember -m "$owner_client" ascclients >/dev/null 2>&1; then
  dseditgroup -o edit -d "$owner_client" -t user ascclients || return 1
 fi
 if [[ "$owned_group" == true ]] && dscl . -read /Groups/ascclients >/dev/null 2>&1; then
  dseditgroup -o delete ascclients || return 1
 fi
 if [[ "$owned_user" == true ]] && dscl . -read /Users/ascdaemon >/dev/null 2>&1; then
  dscl . -delete /Users/ascdaemon || return 1
 fi
 rm -rf "$base"
}
if [[ "$action" == uninstall ]]; then remove_owned; echo 'Removed installation, credentials, socket, releases and installer-owned accounts/membership.'; exit; fi
validate_service_user() {
 local status
 id ascdaemon >/dev/null 2>&1 || fail 'Service account ascdaemon is missing.'
 status="$(sysadminctl -secureTokenStatus ascdaemon 2>&1 || true)"
 [[ "$status" == *'DISABLED'* && "$status" != *'ENABLED'* ]] || fail 'ascdaemon Secure Token must be DISABLED; existing tokens are never changed.'
 id -Gn ascdaemon | grep -qw admin && fail 'ascdaemon must not belong to admin.'
 [[ "$(dscl . -read /Users/ascdaemon UserShell | awk '$1 == "UserShell:" && NF == 2 {print $2}')" == /usr/bin/false ]] || fail 'Existing ascdaemon must use /usr/bin/false.'
 return 0
}
if [[ "$action" == update || "$action" == rollback ]]; then validate_service_user; fi
# Repair links created by earlier preview installers, without touching targets.
if [[ "$action" == update || "$action" == rollback ]]; then
 for link in current bridge previous; do
  [[ ! -L "$base/$link" ]] || chmod -h 0755 "$base/$link"
 done
fi
if [[ "$action" == rollback ]]; then
 validate_manifest
 [[ -L "$base/previous" && -L "$base/current" ]] || fail 'No previous release is available.'
 previous="$(readlink "$base/previous")"; current="$(readlink "$base/current")"
 [[ "$previous" == releases/* && "$current" == releases/* && "$previous" != *..* && "$current" != *..* ]] || fail 'Invalid release links.'
 "$base/$previous/node" --input-type=module - "$base/$previous" "$base/private/apps.json" <<'JS'
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const dir=process.argv[2];const validation=readFileSync(dir+'/asc-daemon.mjs');
// Older releases may precede policy configuration; import-check the code before rollback.
await import(pathToFileURL(dir+'/asc-daemon.mjs'));
const {existsSync}=await import('node:fs');if(existsSync(dir+'/asc-runtime.mjs')) {const {validateConfiguration:validateConfig}=await import(pathToFileURL(dir+'/asc-runtime.mjs'));await validateConfig(JSON.parse(readFileSync(process.argv[3])));}
JS
 rollback_stopped=false; rollback_switched=false; rollback_completed=false
 rollback_cleanup() {
  local status=$?
  set +e
  if [[ "$rollback_completed" != true ]]; then
   if [[ "$rollback_switched" == true ]]; then
    if launchctl print system/local.asc-scoped >/dev/null 2>&1; then launchctl bootout system/local.asc-scoped; fi
    rm -f "$base/.switch"
    ln -s "$current" "$base/.switch" && mv -fh "$base/.switch" "$base/current"
   fi
   rm -f "$base/.switch"
   if [[ "$rollback_stopped" == true ]]; then launchctl bootstrap system "$plist" || true; fi
  fi
  action_lock_release
  exit "$status"
 }
 trap rollback_cleanup EXIT
 if launchctl print system/local.asc-scoped >/dev/null 2>&1; then
  launchctl bootout system/local.asc-scoped
  rollback_stopped=true
 fi
 ln -s "$previous" "$base/.switch"; mv -fh "$base/.switch" "$base/current"
 rollback_switched=true
 launchctl bootstrap system "$plist"
 ln -s "$current" "$base/.switch"; mv -fh "$base/.switch" "$base/previous"
 rollback_completed=true
 echo 'Restored previous code release. Configuration and credentials retained.'; exit
fi
if [[ "$action" == install ]]; then
 [[ ! -e "$base" && ! -L "$base" && ! -e "$plist" && ! -L "$plist" ]] || fail 'Installation exists. Use update; legacy installs need explicit migration (see README).'
 [[ -f "$config" ]] || fail 'Pass --config /path/to/config.json (or a legacy alias-to-ID JSON file).'
 [[ "$client" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ && "$client" != root && "$client" != ascdaemon ]] || fail 'Pass --client with a normal local account, or use sudo from that account.'
 id "$client" >/dev/null 2>&1 || fail 'Client account does not exist.'
else
 if [[ ! -f "$manifest" && "$adopt_legacy" == true ]]; then
  [[ -d "$base/private" && ! -L "$base/private" && -f "$plist" && -f "$base/private/apps.json" ]] || fail 'No compatible legacy install exists.'
  trusted "$base" && trusted "$plist" || fail 'Legacy installation paths must be administrator controlled.'
  [[ ! -e "$base/current" && ! -L "$base/current" && ! -e "$base/bridge" && ! -L "$base/bridge" ]] || fail 'Legacy adoption requires an unversioned installation.'
  [[ "$client" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ && "$client" != root && "$client" != ascdaemon ]] || fail 'Legacy adoption requires --client or SUDO_USER.'
 else validate_manifest; fi
 [[ -z "$config" ]] || fail 'Update preserves private/apps.json. Review and migrate that file explicitly before updating.'
 config="$base/private/apps.json"
fi
staging="$(mktemp -d /private/tmp/asc-deploy.XXXXXXXX)"; chmod 0700 "$staging"
started=false; completed=false; switched=false; old_current=''; release=''
adoption_started=false; adoption_launcher_changed=false; legacy=''
state_created=false; maintenance_created=false; was_registered=false; base_created=false
private_owner=''; private_mode=''
cleanup() {
 local status=$?
 set +e
 if [[ "$completed" != true && "$started" == true ]]; then
  if [[ "$action" == install ]]; then remove_owned || echo 'Cleanup incomplete: consult install manifest.' >&2
  else
   launchctl bootout system/local.asc-scoped >/dev/null 2>&1 || true
   if [[ "$switched" == true ]]; then
    rm -f "$base/.switch"; ln -s "$old_current" "$base/.switch"; mv -fh "$base/.switch" "$base/current"
   fi
   rm -f "$base/.switch"
   if [[ "$adoption_launcher_changed" == true ]]; then
    install -o root -g wheel -m 0555 "$staging/legacy-launcher.sh" "$base/private/run-asc-daemon.sh"
   fi
   if [[ "$was_registered" == true ]]; then launchctl bootstrap system "$plist" || true; fi
  fi
 fi
 if [[ "$completed" != true && "$adoption_started" == true ]]; then
  if [[ "$adoption_launcher_changed" == true ]]; then
   install -o root -g wheel -m 0555 "$staging/legacy-launcher.sh" "$base/private/run-asc-daemon.sh"
  fi
  if [[ -n "$private_owner" ]]; then
   chown "$private_owner" "$base/private"
   chmod "$private_mode" "$base/private"
  fi
  rm -f "$base/current" "$base/bridge" "$base/previous" "$base/.switch" "$manifest"
  [[ -z "$legacy" ]] || rm -rf "$base/$legacy"
  rmdir "$base/releases" 2>/dev/null || true
  echo 'Legacy adoption failed: original launcher restored; credentials and accounts preserved.' >&2
 fi
 if [[ "$completed" != true && "$action" == install && "$base_created" == true && "$started" != true ]]; then
  rm -rf "$base"
 fi
 if [[ "$completed" != true && "$action" == update ]]; then
  [[ "$state_created" != true ]] || rm -rf "$base/state"
  [[ "$maintenance_created" != true ]] || rm -rf "$base/maintenance"
 fi
 [[ "$completed" == true || -z "$release" || "$action" != update ]] || rm -rf "$base/$release"
 if [[ "$completed" != true && "$adoption_started" == true ]]; then rmdir "$base/releases" 2>/dev/null || true; fi
 rm -rf "$staging"
 action_lock_release
 exit "$status"
}
trap cleanup EXIT
mkdir "$staging/runtime"
for file in "$source_dir"/*.mjs "$source_dir"/asc-resource-catalog.json; do
 [[ -f "$file" ]] || continue
 case "$(basename "$file")" in *.test.mjs|*fixture*|asc-scoped-mcp.mjs|package*.json) continue;; esac
 cp "$file" "$staging/runtime/"
done
[[ ! -d "$source_dir/catalog" ]] || cp -R "$source_dir/catalog" "$staging/runtime/catalog"
[[ -d "$source_dir/node_modules" ]] || fail 'Run npm ci in the checkout first.'
cp -R "$source_dir/node_modules" "$staging/runtime/node_modules"
ln -s "$node_path" "$staging/runtime/node"
# Config is normalized into private state only on a fresh install.
"$node_path" --input-type=module - "$staging/runtime" "$config" "$staging/config.json" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const dir=process.argv[2];const {validateConfiguration:validateConfig}=await import(pathToFileURL(dir+'/asc-runtime.mjs'));
let config=JSON.parse(readFileSync(process.argv[3]));if(!Object.hasOwn(config,'apps'))config={apps:config};
await validateConfig(config);await import(pathToFileURL(dir+'/asc-daemon.mjs'));await import(pathToFileURL(dir+'/asc-operations.mjs'));
writeFileSync(process.argv[4],JSON.stringify(config,null,2)+'\n');
JS
if [[ "$action" == install ]]; then
 /bin/bash "$source_dir/launchd/stage-op.sh" "$staging/op" "$op_path"
 /usr/bin/clang -Wall -Wextra -Werror "$source_dir/launchd/activate-socket.c" -o "$staging/activate-socket"
 user_exists=false; group_exists=false; member_exists=false; secure_token=DISABLED
 if dscl . -read /Users/ascdaemon >/dev/null 2>&1; then
  user_exists=true
  validate_service_user
  secure_token=DISABLED
 fi
 dscl . -read /Groups/ascclients >/dev/null 2>&1 && group_exists=true
 if [[ "$group_exists" == true ]] && dseditgroup -o checkmember -m "$client" ascclients >/dev/null 2>&1; then member_exists=true; fi
 "$node_path" --input-type=module - "$source_dir/launchd/install-plan.mjs" "$client" "$user_exists" "$group_exists" "$member_exists" "$create_user" > "$staging/manifest.json" <<'JS'
import {pathToFileURL} from 'node:url';const {installPlan}=await import(pathToFileURL(process.argv[2]));
const [client,u,g,m,c]=process.argv.slice(3);const plan=installPlan({client,userExists:u==='true',groupExists:g==='true',memberExists:m==='true',createUser:c==='true'});
// Intended ownership is journaled atomically before each absent-resource mutation.
plan.createdUser=false;plan.createdGroup=false;plan.addedMembership=false;console.log(JSON.stringify(plan,null,2));
JS
 [[ -r /dev/tty ]] || fail 'Use your Terminal for credential prompts.'
 read -r -p '1Password Environment ID: ' environment_id </dev/tty
 [[ "$environment_id" =~ ^[[:alnum:]_-]{1,128}$ ]] || fail 'Invalid Environment ID.'
 read -r -s -p '1Password service account token (hidden): ' op_token </dev/tty; printf '\n' >/dev/tty
 [[ "$op_token" =~ ^[[:alnum:]_.=+/-]+$ ]] || fail 'Invalid service account token.'
 install -d -o root -g wheel -m 0755 "$base"
 base_created=true
 install -o root -g wheel -m 0600 "$staging/manifest.json" "$manifest"; started=true
 if [[ "$user_exists" != true ]]; then
  uid=499
  while dscl . -search /Users UniqueID "$uid" | grep -q .; do uid=$((uid-1)); [[ "$uid" -gt 200 ]] || fail 'No unused service UID below 500.'; done
  dscl . -read /Users/ascdaemon >/dev/null 2>&1 && fail 'Service account appeared during installation; refusing to claim ownership.'
  journal_mutation createdUser dscl . -create /Users/ascdaemon
  dscl . -create /Users/ascdaemon UniqueID "$uid"
  dscl . -create /Users/ascdaemon PrimaryGroupID 1
  dscl . -create /Users/ascdaemon UserShell /usr/bin/false
  dscl . -create /Users/ascdaemon NFSHomeDirectory /var/empty
  dscl . -create /Users/ascdaemon IsHidden 1
  dscl . -create /Users/ascdaemon AuthenticationAuthority ';DisabledUser;'
  dscl . -create /Users/ascdaemon Password '*'
  secure_token="$(sysadminctl -secureTokenStatus ascdaemon 2>&1 || true)"
  [[ "$secure_token" == *'DISABLED'* && "$secure_token" != *'ENABLED'* ]] || fail 'Created user Secure Token could not be verified DISABLED.'
 fi
 if [[ "$group_exists" != true ]]; then
  dscl . -read /Groups/ascclients >/dev/null 2>&1 && fail 'Client group appeared during installation; refusing to claim ownership.'
  journal_mutation createdGroup dseditgroup -o create ascclients
 fi
 if [[ "$member_exists" != true ]]; then
  dseditgroup -o checkmember -m "$client" ascclients >/dev/null 2>&1 && fail 'Client membership appeared during installation; refusing to claim ownership.'
  journal_mutation addedMembership dseditgroup -o edit -a "$client" -t user ascclients
 fi
 install -d -o root -g wheel -m 0711 "$base/private"
 install -d -o root -g ascclients -m 0710 "$base/run"
 install -o root -g wheel -m 0555 "$staging/op" "$staging/activate-socket" "$source_dir/launchd/run-asc-daemon.sh" "$base/private/"
 install -o ascdaemon -g wheel -m 0400 "$staging/config.json" "$base/private/apps.json"
 printf '%s\n' "$environment_id" > "$base/private/environment-id"
 printf '%s\n' "$op_token" > "$base/private/op-token"; unset op_token
 chown ascdaemon:wheel "$base/private/environment-id" "$base/private/op-token"; chmod 0400 "$base/private/environment-id" "$base/private/op-token"
 cp "$source_dir/launchd/local.asc-scoped.plist" "$staging/job.plist"
 gid="$(dscl . -read /Groups/ascclients PrimaryGroupID | awk '{print $2}')"
 [[ "$gid" =~ ^[0-9]+$ && "$gid" != 0 ]] || fail 'Invalid client group ID.'
 plutil -replace Sockets.ASCListener.SockPathGroup -integer "$gid" "$staging/job.plist"
 plutil -lint "$staging/job.plist"
 install -o root -g wheel -m 0644 "$staging/job.plist" "$plist"
fi
install -d -o root -g wheel -m 0755 "$base/releases"
release="releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mv "$staging/runtime" "$base/$release"; chown -R root:wheel "$base/$release"; chmod -R a+rX,go-w "$base/$release"
if [[ "$action" == update && "$adopt_legacy" == true && ! -f "$manifest" ]]; then
 # The owner explicitly adopts legacy installed files, but no existing account,
 # group or membership is ever claimed as installer-created.
 private_owner="$(stat -f '%u:%g' "$base/private")"
 private_mode="$(stat -f %Lp "$base/private")"
 adoption_started=true
 cp "$base/private/run-asc-daemon.sh" "$staging/legacy-launcher.sh"
 legacy="releases/legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
 mkdir "$base/$legacy"
 for file in "$base/private"/*.mjs "$base/private"/asc-resource-catalog.json; do
  [[ -f "$file" ]] || continue
  [[ "$(basename "$file")" != apps.json ]] || continue
  cp "$file" "$base/$legacy/"
 done
 cp -R "$base/private/node_modules" "$base/$legacy/node_modules"
 ln -s "$node_path" "$base/$legacy/node"
 chown -R root:wheel "$base/$legacy"; chmod -R a+rX,go-w "$base/$legacy"
 "$node_path" --input-type=module - "$source_dir/launchd/install-plan.mjs" "$client" > "$manifest" <<'JS'
import {pathToFileURL} from 'node:url';const {installPlan}=await import(pathToFileURL(process.argv[2]));console.log(JSON.stringify(installPlan({client:process.argv[3],userExists:true,groupExists:true,memberExists:true}),null,2));
JS
 chmod 0600 "$manifest"; chown root:wheel "$manifest"
 ln -s "$legacy" "$base/current"; ln -s current "$base/bridge"
 # Rollback uses the compatible versioned launcher and copied legacy release.
 chown root:wheel "$base/private"
 chmod 0711 "$base/private"
 adoption_launcher_changed=true
 install -o root -g wheel -m 0555 "$source_dir/launchd/run-asc-daemon.sh" "$base/private/run-asc-daemon.sh"
fi
if [[ "$action" == update ]]; then
 [[ -L "$base/current" ]] || fail 'No versioned current release; explicit legacy migration required.'
 old_current="$(readlink "$base/current")"
 [[ "$old_current" == releases/* && "$old_current" != *..* ]] || fail 'Invalid current release.'
 started=true
 if launchctl print system/local.asc-scoped >/dev/null 2>&1; then
  was_registered=true
  launchctl bootout system/local.asc-scoped
 fi
fi
# Editors may replace this file with a root-only file. Restore the same
# daemon-only read access used by a fresh installation; never print its contents.
chown ascdaemon:wheel "$base/private/apps.json"
chmod 0400 "$base/private/apps.json"
# Writable provider state is separate from the root-controlled credential directory.
[[ -e "$base/state" ]] || state_created=true
install -d -o ascdaemon -g wheel -m 0700 "$base/state"
[[ -e "$base/maintenance" ]] || maintenance_created=true
install -d -o root -g wheel -m 0755 "$base/maintenance"
install -o root -g wheel -m 0555 "$source_dir/launchd/uninstall.sh" "$source_dir/launchd/uninstall-owned.sh" "$source_dir/launchd/manifest-utils.sh" "$source_dir/launchd/action-lock.sh" "$base/maintenance/"
# Refresh the launcher for existing versioned installations as well.
if [[ "$action" == update && "$adoption_launcher_changed" != true ]]; then
 cp "$base/private/run-asc-daemon.sh" "$staging/legacy-launcher.sh"
 adoption_launcher_changed=true
fi
install -o root -g wheel -m 0555 "$source_dir/launchd/run-asc-daemon.sh" "$base/private/run-asc-daemon.sh"
ln -s "$release" "$base/.switch"
mv -fh "$base/.switch" "$base/current"
switched=true
if [[ "$action" == install ]]; then ln -s current "$base/bridge"; fi
launchctl bootstrap system "$plist"
if [[ "$action" == update ]]; then ln -s "$old_current" "$base/.switch"; mv -fh "$base/.switch" "$base/previous"; fi
completed=true
echo 'LaunchDaemon registered. Verify discovery with the stable bridge before using writes.'
echo "Bridge: $base/bridge/asc-bridge.mjs"
