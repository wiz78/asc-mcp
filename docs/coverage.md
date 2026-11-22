# Catalogue coverage

The preview pins asc CLI 6.6.1 and Apple's public API 4.6.1. The bundled
catalog/api.json includes 1,342 endpoint operations and 1,517 shared schemas.
catalog/cli.json records 1,994 CLI groups and leaves in 11 help categories.

Each API tool has a stable name, method, path, resource type, category,
inferred command family, parameters and request-body schema. Generated tools
issue direct API requests.

Every CLI entry records its coverage reason and related API operation names.
Credential export is unavailable. Local builds, screenshot framing, shell
workflows and external-service integrations need separate adapters. Public
API coverage does not provide Apple web-session-only functionality.

App scope currently understands the metadata/Game Center models plus explicit
parent models in asc-api.mjs. It denies unresolved ownership. Discovered
operations may additionally require a documented app filter or verified
parent endpoint. Explicit team scope can expose any catalogue operation
allowed by policy. Apple still enforces key roles and request validation.

Required tests validate catalogue references and selected writes, relationship
checks, uploads and sanitized errors against fixtures. They do not claim live
coverage of all 1,342 operations.

## Media upload adapters

The bridge includes complete reserve/transfer/MD5-commit/status flows for
PNG/JPEG screenshots in appScreenshotSets and MOV/MP4/M4V previews in
appPreviewSets. The matching generated API tools manage the sets, asset records,
ordering and metadata. These adapters target the set-based API; the newer Asset
Library resource families have generated API operations but no file-transfer
adapter. Game Center image uploads retain their existing flow.

Account-free tests exercise screenshot and preview uploads end-to-end through
the MCP bridge against a fake daemon/Apple transport, including multipart bytes,
checksums, processing, retries, ownership and policy denials. No live Apple
account upload is performed.

## Catalogue provenance

The generator uses CLI help/schema commands and Apple's public specification
without authenticating. Catalogue generation is outside the account-free
runtime test suite and uses the pinned CLI plus public network access.

Source URLs, the specification SHA-256, versions and inventory method are
recorded in the catalogue. A different catalogue can expand broad allow
policies.

- [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/)
