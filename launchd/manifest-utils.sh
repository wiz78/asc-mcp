#!/bin/bash
# Read-only manifest parsing. System plutil enforces JSON value types.
manifest_value() {
 /usr/bin/plutil -extract "$2" raw -expect "$3" -o - "$1" 2>/dev/null
}
manifest_validate() {
 local manifest_file="$1" value flag
 [[ "$(manifest_value "$manifest_file" version integer)" == 1 ]] || return 1
 [[ "$(manifest_value "$manifest_file" base string)" == '/Library/Application Support/ASCScoped' ]] || return 1
 [[ "$(manifest_value "$manifest_file" plist string)" == '/Library/LaunchDaemons/local.asc-scoped.plist' ]] || return 1
 [[ "$(manifest_value "$manifest_file" user string)" == ascdaemon ]] || return 1
 [[ "$(manifest_value "$manifest_file" group string)" == ascclients ]] || return 1
 value="$(manifest_value "$manifest_file" client string)" || return 1
 [[ "$value" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ && "$value" != root && "$value" != ascdaemon ]] || return 1
 for flag in createdUser createdGroup addedMembership; do
  value="$(manifest_value "$manifest_file" "$flag" bool)" || return 1
  [[ "$value" == true || "$value" == false ]] || return 1
 done
}
