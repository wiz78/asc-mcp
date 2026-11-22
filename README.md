# asc-mcp

App Store Connect tools for MCP clients, backed by a local service that holds
the Apple Team API key under a separate macOS identity. The service checks an
app allowlist and operation policy before making requests. Each project
selects a configured app alias. Account operations use a separate team scope
that is disabled by default.

This preview runs on macOS and was tested on Golden Gate. It might work on
previous macOS versions too; those have not been verified. See the
[prerequisites](#prerequisites) for hardware, software and account setup.

## Available tools

The pinned catalogue contains 1,342 public Apple API operations from API 4.6.1,
grouped using asc CLI 6.6.1 categories. Existing convenience tools cover app
and version metadata, Game Center achievements, leaderboards, challenges and
their image uploads. Generated tools use API schemas for path, query and body
arguments.

App scope exposes operations with implemented ownership checks and rejects
requests whose ownership cannot be established. Explicit team scope can expose
selected schema-backed account operations. The command inventory lists
1,994 asc command groups/leaves and explains partial coverage, credential
exclusions, and local/external workflows. See [coverage](docs/coverage.md).

## Prerequisites

**The installer does not download or install missing dependencies.** Prepare the
following before running it:

- **macOS on an Apple Silicon Mac.** Golden Gate is the tested macOS release;
  previous releases may also work. The current installer targets arm64 hardware.
- **Administrator access** to install/register a system LaunchDaemon and, if
  needed, create its service account and client group.
- **Apple Command Line Tools**, including Git and Clang. Clang compiles the
  socket-activation helper during a fresh installation.
- **Node.js and npm.** Tested with Node.js 24, locally 24.19.0, using the official
  macOS package. Other versions/distributions are accepted with warnings for
  untested versions; code/configuration validation must still succeed. Keep the
  selected Node installation available after setup.
- **The signed 1Password CLI (`op`)** and a 1Password account supporting a
  dedicated Environment and service account. The daemon uses that service
  account without depending on an interactive desktop sign-in.
- **An Apple Team API key for App Store Connect**, with the roles needed for
  your permitted actions. You need its key ID, issuer ID and private key.
- **A local stdio MCP client**, such as Codex or Claude Code, running under a
  macOS account authorized to access the daemon's socket.
- **Outbound HTTPS access** to 1Password, Apple's API and Apple's upload storage
  for live operations. Dependency installation also needs access to npm.

**Homebrew is optional.** You can use the official Node.js and 1Password package
installers without it. Homebrew installations are accepted too; setup accepts
explicit executable paths. Anyone able to replace the selected Node runtime
or its libraries must be trusted with the daemon credentials.

**The `asc` CLI is not needed at runtime or for normal installation.** The API
and command catalogues are bundled. `asc` is only needed to regenerate the
catalogue during development.

### Install the prerequisites and checkout

Install Apple's Command Line Tools if missing, and complete the macOS prompt:

~~~sh
xcode-select --install
~~~

Install Node.js with npm from the [official Node.js downloads](https://nodejs.org/en/download)
(select Node.js 24 and the macOS package to match the tested setup). Install
`op` using the macOS package in the [official 1Password CLI instructions](https://developer.1password.com/docs/cli/get-started/).
If you already use Homebrew, you may install these tools through it instead;
ensure the selected executables are on your shell's PATH.

Verify the tools, then download this repository and install its JavaScript
dependencies as your normal user:

~~~sh
node --version
npm --version
op --version
command -v node
command -v op

git clone https://github.com/wiz78/asc-mcp.git
cd asc-mcp
npm ci --ignore-scripts
~~~

The daemon installer copies these dependencies into its release directory; it
does not run npm for you. It verifies and installs a private copy of your signed
`op` binary, reuses your selected Node executable and sets up the service files.
Shared Node, npm and 1Password installations remain yours to manage.

## Policies

Configuration is JSON. A project selects an alias; the installed daemon owns
the policy.

~~~json
{
  "apps": {
    "example-app": { "id": "1234567890", "policy": "editor" }
  },
  "team": { "enabled": false },
  "policies": {
    "editor": {
      "allow": ["app-management"],
      "deny": ["pricing"]
    }
  }
}
~~~

Selectors match category or command subtrees. Spaces and slashes are equivalent.
Use read:pricing for pricing reads, read:app-management for app-management
reads, or read:* globally. Deny always wins. Empty allow grants nothing.
Exact generated tool names can select individual API operations. Relationship
endpoints and requested includes also respect resource-family exclusions.

Copy the example to a local configuration file, which is ignored by Git:

~~~sh
cp examples/config.example.json config.local.json
~~~

Edit `config.local.json` with your app's Apple ID, alias and intended policy.
Validate and inspect it before loading credentials; replace `example-app` below
if you changed the alias:

~~~sh
node asc-preview.mjs check config.local.json
node asc-preview.mjs explain config.local.json example-app
~~~

See [policy reference](docs/policy.md).

## Install and connect

After completing the prerequisites and reviewing `config.local.json`, create
a dedicated 1Password Environment containing only:

- `ASC_KEY_ID`: your Apple Team API key ID.
- `ASC_ISSUER_ID`: its issuer ID.
- `ASC_PRIVATE_KEY`: the PEM private key, or `ASC_PRIVATE_KEY_B64`: its Base64
  representation. Use one of these two private-key variables.

Create a [1Password service account](https://developer.1password.com/docs/service-accounts/)
with read access only to that Environment. Have its token and the Environment
ID ready. The installer prompts for both in your own Terminal, hiding the token
input. Keep them out of chat, project files and MCP client configuration.

Run the installer from this checkout in your own Terminal. The executable paths
are resolved from your shell before sudo runs, so this also works with Homebrew:

~~~sh
sudo /bin/bash launchd/install.sh --config "$PWD/config.local.json" \
  --create-service-user --node "$(command -v node)" --op "$(command -v op)"
~~~

The service-user flag explicitly authorizes creating a missing ascdaemon.
The installer makes it hidden, non-login and password-disabled, then verifies
that its Secure Token is disabled. It refuses to alter an existing enabled
Secure Token.

Register the stable bridge with a local **stdio MCP client**. Codex and Claude
Code below are examples; other harnesses may use different configuration files,
keys and project scopes. Use the same executable, bridge path and configured
app alias in the format required by your harness. No ASC or 1Password
credentials belong in the client configuration.

### Codex: one project

Add this to the app project's `.codex/config.toml`:

~~~toml
[mcp_servers.asc_local]
command = "/Library/Application Support/ASCScoped/bridge/node"
args = ["/Library/Application Support/ASCScoped/bridge/asc-bridge.mjs", "example-app"]
~~~

### Claude Code: one project

Run from the app project's root directory, replacing `example-app` with its
configured daemon alias:

~~~sh
claude mcp add --transport stdio --scope project asc_local -- \
  "/Library/Application Support/ASCScoped/bridge/node" \
  "/Library/Application Support/ASCScoped/bridge/asc-bridge.mjs" example-app
~~~

This creates or updates `.mcp.json` in that project. Start Claude Code there and
approve the project MCP server when prompted, then use `/mcp` to check its
status. `claude mcp get asc_local` also shows its configuration/status. For a
registration private to you in this project, use `--scope local` instead of
`--scope project`. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

In either example, use an alias already configured in the daemon's `apps.json`.
Use --team instead of an alias only when team scope has been enabled.
The service starts on a Unix socket request and exits after two idle minutes
by default. It reloads configuration when it starts.

The installer records files, accounts and memberships it owns. Uninstall works
without Node or the source checkout, removes credentials and the installation
directory, and deletes only installer-created accounts/group memberships.
See the [installation, update, rollback and removal guide](launchd/README.md).

## Screenshot and video preview uploads

With `screenshots` or `video-previews` enabled in the app policy, use:

- `upload_screenshot`: `set_id` and absolute `file_path` for a PNG/JPEG.
- `upload_video_preview`: `set_id`, absolute `file_path` and optional
  `preview_frame_time_code` such as `00:00:05:00` for a MOV/MP4/M4V.
- `finish_media_upload`: `upload_id` to retry transfer/commit or poll processing.
- `cancel_media_upload`: `upload_id` to delete the reserved asset and session.

Select or create an owned screenshot/preview set for the intended version
localization and device display type first. The generated
`api_appScreenshotSets_createInstance` and `api_appPreviewSets_createInstance`
tools create these sets. Upload helpers reserve an asset, transfer its bytes,
commit an MD5 checksum and return a normalized `state`, plus the available
`assetDeliveryState`/`videoDeliveryState`. Preview status prefers
`videoDeliveryState` when provided. `COMPLETE` indicates processing success;
`UPLOAD_COMPLETE` or `PROCESSING` needs later polling.
For `FAILED`, inspect the asset with its generated read tool and cancel/retry.
Apple validates screenshot dimensions and preview codecs, duration and sizes.

The bridge streams local files with your user permissions. The daemon checks
set ownership, uses private disk spools, and keeps signed upload URLs internal.
Helper limits are 20 MiB per screenshot, 500 MiB per preview, eight concurrent
spools and 1 GiB of reserved disk space. Completed uploads release spool capacity.
Sessions expire after 30 minutes without upload activity and do not survive a
daemon restart. Retry the same file and set during an active session to resume;
errors include a session ID when available. After a restart, inspect/delete any
unfinished Apple reservation before retrying. Large transfers may need a retry
if the MCP client times out. Use `finish_media_upload` once the session is known.
The old alias-to-ID configuration retains its original tools; these new helpers
require an explicit policy. They are app-scoped and unavailable in team scope.

## Check the running daemon

From the source checkout:

```sh
node asc-preview.mjs status example-app
node asc-preview.mjs tools example-app
node asc-preview.mjs tools example-app --filter screenshots
node asc-preview.mjs tools example-app --json
```

Use your configured alias, or `--team` for an enabled team scope. These commands
query live tool discovery, start the daemon on demand and make no Apple API
requests. Status confirms discovery works for the selected scope; it does not
check Apple API access. `--json` emits machine-readable output; `--socket PATH`
selects a different Unix socket. Failures return a nonzero exit status.

## Test without accounts

~~~sh
npm test
npm run check
npm run test:macos
node scripts/audit-package.mjs
~~~

Required tests use generated keys, fake Apple responses, temporary Unix
sockets, and no Apple or 1Password accounts. External fetch and TCP calls are
blocked. The macOS lifecycle test uses a temporary job and synthetic
credentials. It never creates a system service user.

The optional npm run test:codex compatibility test needs a separately
installed/configured Codex client. It uses a fake Apple service and is excluded
from required tests and CI. CI runs the account-free suite on arm64 macOS.

## Limits and security

All local ascclients members can select every configured app or enabled team
scope. Administrators and the daemon identity remain trusted. The daemon
enforces policy even against custom socket clients.

Generated tools do not run shell/CLI commands, expand file references, or
export Apple/1Password credentials. Signed upload instructions stay internal.
Errors are bounded and sanitized. Binary API downloads return base64 up to a
16 MiB response limit.

Privileged install/account removal has simulated ownership and manifest
coverage. Privileged end-to-end validation on a disposable Mac is outside
the automated test coverage. API fixtures do not establish live coverage
of every operation. See [security](docs/security.md) and
[vulnerability reporting](SECURITY.md).

## License

ISC. Public Apple schema provenance is recorded in
[coverage](docs/coverage.md).
