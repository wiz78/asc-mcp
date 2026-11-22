#!/bin/bash
set -euo pipefail
target="${1:?Provide a private staging destination}"
source_op="${2:-$(command -v op || true)}"
[[ -n "$source_op" && -x "$source_op" ]] || { echo 'Install official 1Password CLI and pass --op /absolute/path/to/op.' >&2; exit 1; }
/usr/bin/install -m 0755 "$source_op" "$target"
/usr/bin/codesign --verify --strict -R='anchor apple generic and identifier "com.1password.op" and certificate leaf[subject.OU] = "2BUA8C4S2C"' "$target"
if /usr/bin/xattr "$target" | /usr/bin/grep -qx com.apple.quarantine; then /usr/bin/xattr -d com.apple.quarantine "$target"; fi
/bin/chmod 0555 "$target"
