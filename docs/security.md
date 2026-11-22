# Security model

The service holds an Apple Team key and 1Password service-account token under
a dedicated non-login macOS identity. The bridge has no such credentials.
Normal operations select a server-configured app alias. The daemon validates
ownership and policy before making requests.

Every ascclients member can select every configured alias and enabled team
scope. Projects belonging to the same macOS account share that access. Team
scope intentionally permits configured account operations across apps.

Root, administrators, the daemon identity, runtime, credential provider,
configuration and Apple are trusted. Administrator replacement of the service
and independent credentials available to the agent's account are outside
this boundary. Node preflight warnings do not enforce runtime ownership or
library provenance. Anyone who can replace the selected Node runtime or its
dependencies must also be trusted with the daemon credentials.

Known parent relationships establish ownership. Arbitrary IDs found in JSON
do not grant access. Related mutation IDs are checked. Unknown ownership
models are denied in app scope. Shared Game Center writes require every
affected app in the allowlist.

The service executes no caller-supplied shell or asc command. API paths and
schemas come from the pinned catalogue. Redirects and arbitrary API origins
are unavailable. The bridge reads upload files using the caller's permissions;
the daemon receives bounded chunks rather than a filesystem path. Upload
instructions are validated and remain internal. Apple JWTs are never sent to
upload hosts.

Error projection permits bounded code/title/detail/source fields and redacts
known credentials, private keys, JWTs, bearer values and URLs. A final output
guard rejects recognized credential material. Application data and public
identifiers returned by approved operations can reach the client's context.

Required tests block external fetch/TCP and inject fake API/upload transports.
Installer tests exercise ownership and the native manifest parser without
creating users or services. Privileged end-to-end installation is outside the automated test coverage.

Use a dedicated 1Password Environment with only the required ASC variables
and minimum service-account access. Keep tokens out of project files, MCP
configuration, command arguments and issue reports.


Screenshot and preview bytes are streamed to private daemon-owned spool files
under the installed state directory, with 0700 directories and 0600 files.
Ownership is checked through the set, version localization and version to the
configured app before reservation, and again before commit/cancellation using
the existing bounded ownership cache. Chunk requests use only the app/alias-bound
session, avoiding repeated Apple ownership requests. SHA-256 verifies received
bytes; the daemon computes the MD5 commit checksum. Upload destinations and
headers use the same allowlist as Game Center, with redirects rejected and no
ASC bearer token sent to upload storage. Signed URLs/headers never leave the
daemon. Completion, cancellation, expiry and normal shutdown remove spool files;
the next daemon startup removes orphaned spools in its private state directory.
Uninstall removes that directory as part of the dedicated installation.
