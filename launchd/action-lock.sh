#!/bin/bash
# All deployment entry points share an atomic directory in a root-only parent.
action_lock_path='/Library/Application Support/.asc-scoped-deploy.lock'
action_lock_held=false
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
action_lock_release() {
 if [[ "$action_lock_held" == true ]]; then
  rm -f "$action_lock_path/pid"
  rmdir "$action_lock_path" || echo "Could not release deployment lock: $action_lock_path" >&2
  action_lock_held=false
 fi
 return 0
}
action_lock_acquire() {
 local parent
 parent="$(dirname "$action_lock_path")"
 while :; do
  [[ ! -L "$parent" && "$(stat -f %u "$parent")" == 0 && $((8#$(stat -f %Lp "$parent") & 8#22)) == 0 ]] || {
   echo 'Deployment lock ancestors must be root-owned and not group/world writable.' >&2; return 1;
  }
  [[ "$parent" == / ]] && break
  parent="$(dirname "$parent")"
 done
 if ! mkdir -m 0700 "$action_lock_path"; then
  echo "Deployment lock exists: $action_lock_path. Verify no install/update/rollback/repair/uninstall is running before manually removing this stale lock." >&2
  return 1
 fi
 action_lock_held=true
 printf '%s\n' "$$" > "$action_lock_path/pid"
}
