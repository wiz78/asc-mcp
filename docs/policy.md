# Configuration and policy reference

The daemon loads JSON from its protected private/apps.json. Validate a
candidate with asc-mcp-preview check CONFIG. The preview CLI loads no
credentials. Restart the daemon after editing installed configuration.

## Scopes and profiles

The apps object maps aliases to objects with id and policy. The policies
object maps profile names to allow arrays and optional deny arrays. Team scope
defaults to disabled; enabling it needs enabled true and a defined policy.
Team policy has account scope and permits selected operations across apps.

The old apps alias-to-ID string map retains the 69 legacy tools. It does not
enable the generated catalogue. Existing installations are not automatically
upgraded.

## Selectors

| Selector | Meaning |
| --- | --- |
| app-management | Supported operations in that category |
| pricing | Pricing and availability family |
| pricing availability | Availability subgroup |
| read:pricing | GET operations in pricing |
| read:app-management | GET operations in app management |
| read:* | GET operations globally |
| write:pricing | Mutating pricing operations |
| app-management/pricing/availability/** | Equivalent availability subtree |
| api_apps_getInstance | Exact generated API operation |
| read-only:pricing | Alias for read:pricing |

Deny always wins, even over a more specific allow. Related resource domains
are checked for relationship endpoints, and included resources need policy
permission too. There is no implicit grant.
Unknown selectors fail validation. A deny selector that matches only CLI
inventory entries and has no executable tool mapping is rejected. Use a
broader resource family or an exact API tool name in that case. An allow
selector for an unavailable workflow grants no executable tools. Category/group rules are the
recommended compact interface. Read classification follows HTTP GET.

Generated command paths are inferred from resource families. They do not
reproduce every multi-step CLI workflow. Use exact generated API names when
selecting an individual operation.

The explain command prints category, command, mode, matching rules, effective
availability and ownership limitations. The catalog command prints endpoint
metadata. Both are account-free.

## Enforcement

The daemon filters MCP discovery and checks policy on every call. Direct calls
to hidden operations are rejected. Internal image begin/chunk requests need
upload permission; commit/poll and cancellation need their corresponding
public permissions. The project cannot replace daemon credentials or policy.

App calls use known parent relationships. Cross-app IDs and relationship-write
references are checked. Unknown parent models fail closed. App-owned root
collections need a verified parent endpoint or documented app filter.
Included response resources never establish ownership.

Nomination tools (`api_nominations_*`) support app scope with the `nominations`
selector. Collection requests inject `filter[relatedApps]` for the selected app;
Apple also requires `filter[state]`. Each returned nomination is verified using
its canonical `relatedApps` relationship, independently of sparse response
fields. An app-scoped request fails if a nomination has missing, incomplete,
empty, or foreign app linkage, including nominations shared across apps.
Shared nominations require explicit team scope. Creation and relationship
updates must name only the selected app, and referenced in-app events must
belong to it. Existing nomination ownership is fetched again before each
read, update, or deletion; these checks are not cached. Listing adds one
ownership request per nomination. Included resources are stripped as usual.

idleTimeoutMs defaults to 120000 and accepts 100 through 3600000. Ownership
caches last up to ten minutes of a daemon run. Grouped Game Center mutations
recheck membership and require all affected apps to be allowed.

Image helpers use the target family's permissions at reservation time and the
saved session target for subsequent chunks, commits and cancellation. Shared
Game Center mutations require permission under every affected app profile.
Each mutation receives its own authorization check, including concurrent calls.


Screenshot/video-preview helpers follow the `screenshots` and `video-previews`
families. Begin and chunks require the target family's upload permission;
commit/poll and cancellation require their public helper permissions under that
same family. Session targets are recorded by the daemon; callers cannot change
them by switching tool names. A deny on one family does not block the other,
and neither `read:*` nor a Game Center image grant enables media uploads.
New media helpers require policy configuration and app scope.
