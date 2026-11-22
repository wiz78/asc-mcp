# Launch daemon

The LaunchDaemon retains label `local.asc-scoped` and socket
`/Library/Application Support/ASCScoped/run/asc.sock`. A socket request starts
the daemon; its default two minute idle exit discards credentials and caches.
Every member of `ascclients` can select every configured app or enabled team
scope. Restrict this local group accordingly.

## Requirements and installation

Complete the [prerequisites and installation steps in the main README](../README.md#prerequisites)
first. That is the central list of hardware, software and account requirements,
including the tested macOS and Node versions. The installer does not install
missing dependencies. Homebrew is optional, and `asc` is not required at runtime.
The deployment scripts resolve executables from the invoking PATH;
`--node /absolute/path` and `--op /absolute/path` override this.
Other Node versions/distributions, user-owned Homebrew/nvm paths and third-party
dylibs are accepted. Preflight warns about untested versions/architectures and
mutable runtime paths rather than rejecting them. The selected path must be an
executable, and actual configuration/import validation must succeed. No
executable is downloaded. Anyone who can replace Node or its dependencies can
affect the credentialed daemon; a runtime protected from the agent's account
preserves the intended isolation boundary.
The installed Node path must remain available for service operation; the installer
does not own or uninstall this shared Node installation. Uninstall uses only
macOS system tools and works even if Node or the checkout has been removed.

Copy `examples/config.example.json` to a private local file and edit its
fictitious app IDs and policies. The legacy `{ "example-app": "1234567890" }`
alias map is also accepted at fresh installation. Policies and catalogue
selectors are validated before a service switch. Updates preserve the installed
`private/apps.json`; they do not silently rewrite its policy format.

In 1Password, create a dedicated Environment containing only `ASC_KEY_ID`,
`ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY` or `ASC_PRIVATE_KEY_B64`. Create a service
account with read access only to this Environment. The installer requests its
Environment ID and token in your own Terminal, with hidden token input. Never
put a token in command arguments, chat, a project file, or an MCP configuration.
The launcher injects these variables only into the service via `op run`.
A private copy of `op` must verify against AgileBits' signing requirement before
quarantine is removed from that copy. The original binary is unchanged.

```sh
sudo /bin/bash launchd/install.sh --config /absolute/path/to/private-config.json \
  --create-service-user --node /usr/local/bin/node --op /absolute/path/to/op
```

`--create-service-user` explicitly consents to creating missing `ascdaemon`.
Without it a missing account is an actionable error. The new account is hidden,
has `/usr/bin/false` as its shell, `/var/empty` as its home, disabled
authentication and no usable password. `sysadminctl -secureTokenStatus` must
report DISABLED; the installer never disables an existing Secure Token.
A preexisting account is accepted for a fresh installation only if it is
already non-administrator and non-login.
Its login-screen visibility and authentication settings are left unchanged.
Existing accounts and groups are recorded as preexisting and preserved by
uninstall. Use `--client accountname` when SUDO_USER does not identify the
normal local account that will run the client.

Code and dependencies are root-owned in versioned public releases. The stable
`bridge` link includes all bridge dependencies and no credentials, independent
of this checkout. Credential files are readable only by `ascdaemon`; its
private directory cannot be modified by that account. Provider HOME, configuration
and cache state live separately under `state`, owned by `ascdaemon` with mode
0700; no shared user cache is used. The client socket group
has access only to the listener, not the credential files. Root and other
administrators remain trusted.

Register the bridge in a trusted project's MCP configuration, substituting an
actual configured app alias:

```toml
[mcp_servers.asc_local]
command = "/Library/Application Support/ASCScoped/bridge/node"
args = ["/Library/Application Support/ASCScoped/bridge/asc-bridge.mjs", "example-app"]
```

Sign out and back in after adding your account to `ascclients` if socket access
is denied. Verify read-only `get_app` and MCP discovery before using mutations.
The legacy ignored wrapper can remain on disk for client rollback.

## Updates, rollback and legacy adoption

```sh
npm test
sudo /bin/bash launchd/update.sh --node /usr/local/bin/node
sudo /bin/bash launchd/rollback.sh --node /usr/local/bin/node
```

Updates stage all runtime modules, generated catalogue data and dependencies,
validate the installed configuration and imports, then atomically switch the
release link. Failed launchd registration restores the old link and launcher and attempts
to register it again. Failed legacy adoption restores its original launcher
and removes new release links/state; credentials and accounts remain intact. The previous release remains available for rollback;
configuration and credentials are shared and are not rolled back. This is a
registration check, not an Apple credential or API health check. Verify the
read-only service route afterwards. No Apple requests occur during deployment.

An older installation without a manifest requires the explicit
`update.sh --adopt-legacy` option (and `--client accountname` when needed).
It backs up the installed legacy modules/dependencies into a rollback release,
preserves `private/apps.json`, credentials, service user and group, and marks
all preexisting accounts/membership as unowned. The owner is adopting the
entire dedicated ASCScoped installation directory and plist for eventual
removal. Shared caches and the source checkout are never adopted. Secure Token
must be DISABLED and the existing service account must not be an administrator.
Legacy adoption is not an automatic policy migration: edit and review the
installed config explicitly before enabling new catalogue operations.

Use `sudo /bin/bash launchd/repair-op.sh /absolute/path/to/op` to replace a
verified private CLI copy without changing credentials. Startup output is
discarded to avoid credential-provider diagnostics in logs. Inspect
`sudo launchctl print system/local.asc-scoped` for launch status.

## Full removal

```sh
sudo /bin/bash "/Library/Application Support/ASCScoped/maintenance/uninstall.sh"
```

The root-owned maintenance helper is installed independently of the checkout
and needs no Node runtime. A root-owned, validated `install-manifest.json`
records ownership; macOS plutil validates exact field types and fixed paths. Removal stops
the job, removes its plist, socket, credential files, code, bridge, backups,
release state and the dedicated installation directory. Only installer-added
client membership is removed. Only installer-created `ascclients` and
`ascdaemon` records are deleted; existing accounts/groups and membership are
preserved. Shared Node/1Password installations, caches and the checkout are
left alone. The script refuses unmanifested installations rather than guessing
which account records it owns. Remove the project's MCP entry separately.

## Account-free verification and limits

`node --test launchd/installer.test.mjs` exercises the pure ownership plan used
by the real installer: missing-user consent, disabled Secure Token, fresh
install teardown, preservation of existing accounts/membership and rejection
of manifests that redirect removals. On macOS the suite also exercises the
actual standalone plutil manifest parser, including rejection of string
booleans and missing fields. It never calls sudo, creates accounts,
loads credentials or contacts Apple. `bash -n launchd/*.sh` (or a loop over
scripts) checks syntax. The separate launchd lifecycle test uses a temporary
job and stub credentials. The tests do not cover privileged end-to-end dscl/sysadminctl/Gatekeeper
behavior, account creation or removal on a disposable Apple Silicon Mac. Intel macOS is not supported by this preview.

Uninstall removes local installation-owned state. If the dedicated 1Password
service account and Environment are being retired, revoke/remove them in
1Password separately. They are remote resources created by the owner.
