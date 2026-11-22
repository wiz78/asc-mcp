import { randomUUID } from "node:crypto";
import { z } from "zod";
import catalog from "./asc-resource-catalog.json" with { type: "json" };
import { mediaDefinitions } from "./asc-media-types.mjs";
import { PublicError } from "./asc-errors.mjs";

export const resourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/);
const origin = "https://api.appstoreconnect.apple.com";
const api = kind => { const definition = catalog[kind] || mediaDefinitions[kind]; return "/" + definition.api + "/" + definition.type; };

function attributeSchema(spec, required) {
  let schema;
  if (spec.enum) schema = z.enum(spec.enum);
  else if (spec.type === "boolean") schema = z.boolean();
  else if (spec.type === "integer") schema = z.number().int().safe();
  else if (spec.type === "object") schema = z.record(z.string().max(100), z.string().max(1000));
  else schema = z.string().max(8000);
  if (spec.nullable) schema = schema.nullable();
  return required ? schema : schema.optional();
}

function attributes(spec) {
  const shape = {};
  for (const [name, value] of Object.entries(spec.fields)) {
    shape[name] = name === "locale" ? locale : attributeSchema(value, spec.required.includes(name));
  }
  return z.strictObject(shape);
}

const challengeImageInput = {
  id: resourceId, parent_id: resourceId,
  parent_kind: z.enum(["localization", "version"])
};
export const expandedTools = {};
const operations = new Map();
function register(name, description, schema, operation) {
  expandedTools[name] = [description, schema];
  operations.set(name, operation);
}
for (const [kind, definition] of Object.entries(catalog)) {
  register("get_" + kind, "Read owned " + kind + " information.", z.strictObject(kind === "gc_challenge_image" ? challengeImageInput : { id: resourceId }), { kind, action: "get" });
  if (kind.startsWith("gc_") && kind.endsWith("_localization")) {
    register("get_" + kind + "_image", "Read the image and processing status for an owned localization.", z.strictObject({ localization_id: resourceId }), { kind, action: "image" });
  }
  if (!kind.endsWith("_image")) {
    const plural = kind === "app_info" ? "app_infos" : kind + "s";
    // Retain the existing public list_version_localizations signature.
    if (kind !== "version_localization") {
      const shape = definition.parent === "app" || definition.root ? {} : { parent_id: resourceId };
      register("list_" + plural, "List " + plural + " belonging to the configured app.", z.strictObject(shape), { kind, action: "list" });
    }
    if (definition.create) {
      let attr = attributes(definition.create);
      if (definition.root && kind === "gc_challenge") {
        attr = attr.extend({ challengeType: z.literal("LEADERBOARD").default("LEADERBOARD") });
      }
      const shape = { attributes: attr };
      if (!definition.root) shape.parent_id = resourceId;
      if (kind === "gc_challenge") shape.leaderboard_id = resourceId;
      register("create_" + kind, "Create an owned " + kind + ". Creates a draft; Apple enforces editability.", z.strictObject(shape), { kind, action: "create" });
    }
    if (definition.update && kind !== "version_localization") {
      const shape = {
        id: resourceId,
        attributes: attributes(definition.update)
      };
      if (kind === "gc_challenge") shape.leaderboard_id = resourceId.optional();
      register("update_" + kind, "Update an owned " + kind + ", including archive status where supported.", z.strictObject(shape).refine(value => Object.keys(value.attributes).length > 0 || value.leaderboard_id, "Supply a change"), { kind, action: "update" });
    }
  }
  if (kind.includes("localization") || definition.root || kind.endsWith("_image")) {
    register("delete_" + kind, "Delete an owned " + kind + ". Apple may prohibit deleting released data.", z.strictObject(kind === "gc_challenge_image" ? challengeImageInput : { id: resourceId }), { kind, action: "delete" });
  }
}
register("get_game_center", "Read the configured app's Game Center detail.", z.strictObject({}), { action: "detail" });
register("list_version_media", "Read screenshot/preview placements and legacy media sets for a version localization.", z.strictObject({ localization_id: resourceId }), { action: "media" });
register("get_gc_challenge_default_image", "Read the default image of an owned challenge version.", z.strictObject({ version_id: resourceId }), { action: "defaultImage" });

function assertResource(resource, type, expectedId) {
  if (resource?.type !== type || !resourceId.safeParse(resource.id).success ||
      (expectedId && resource.id !== expectedId)) {
    throw new PublicError("Unexpected App Store Connect response.");
  }
  return resource;
}

export function projectExpanded(resource, kind) {
  const definition = catalog[kind];
  assertResource(resource, definition.type);
  const output = { id: resource.id };
  for (const name of definition.fields) {
    const value = resource.attributes?.[name];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) output[name] = value;
  }
  const state = resource.attributes?.assetDeliveryState;
  if (state && typeof state.state === "string") {
    output.assetDeliveryState = { state: state.state };
    output.assetDeliveryState.errorCodes = (state.errors || []).map(error => error.code).filter(code => typeof code === "string");
  }
  return output;
}

export function createExpandedOperations(apps, request, { now = Date.now, uploads, authorizeShared } = {}) {
  const cache = new Map();
  const pending = new Map();
  const allowedApps = new Set(Object.values(apps));
  const key = (app, kind, id) => JSON.stringify([app, kind, id]);
  function remember(app, kind, resource) {
    cache.set(key(app, kind, resource.id), { resource, expires: now() + 600_000 });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value);
  }
  function cached(app, kind, id) {
    const item = cache.get(key(app, kind, id));
    if (item?.expires > now()) return item.resource;
    cache.delete(key(app, kind, id));
  }
  function invalidate() {
    cache.clear();
  }

  async function collection(path) {
    const result = [];
    let next = path + (path.includes("?") ? "&" : "?") + "limit=200";
    const target = new URL(path, origin);
    for (let page = 0; next && page < 20; page++) {
      const response = await request(next);
      if (!Array.isArray(response?.data)) throw new PublicError("Unexpected App Store Connect collection.");
      result.push(...response.data);
      next = null;
      if (response.links?.next) {
        const url = new URL(response.links.next, origin);
        if (url.origin !== origin || url.username || url.password || url.pathname !== target.pathname) {
          throw new PublicError("Unexpected App Store Connect pagination.");
        }
        for (const [name, value] of target.searchParams) {
          if (url.searchParams.get(name) !== value) throw new PublicError("Unexpected App Store Connect pagination.");
        }
        next = url.pathname + url.search;
      }
    }
    if (next) throw new PublicError("App Store Connect collection exceeds the page limit.");
    return result;
  }

  async function groupOwnership(app, groupId, mutation) {
    const members = await collection("/v1/gameCenterGroups/" + groupId + "/gameCenterDetails?include=app");
    const ids = [];
    for (const detail of members) {
      assertResource(detail, "gameCenterDetails");
      let owner = detail.relationships?.app?.data;
      if (!owner) {
        owner = (await request("/v1/gameCenterDetails/" + detail.id + "?include=app"))?.data?.relationships?.app?.data;
      }
      if (owner?.type !== "apps" || !resourceId.safeParse(owner.id).success) {
        throw new PublicError("Could not establish shared Game Center ownership.");
      }
      ids.push(owner.id);
    }
    if (!ids.includes(app) || (mutation && ids.some(id => !allowedApps.has(id)))) {
      throw new PublicError("Shared Game Center mutation requires every affected app in the allowlist.");
    }
    if (mutation && authorizeShared) await authorizeShared(ids);
  }

  async function verify(app, kind, id, mutation = false, depth = 0) {
    if (depth > 8) throw new PublicError("Could not establish resource ownership.");
    resourceId.parse(id);
    if (kind === "app") {
      if (id !== app) throw new PublicError("Could not establish resource ownership.");
      return { id, type: "apps" };
    }
    const cacheId = key(app, kind, id);
    // Mutation verification is separate because grouped resources may affect
    // additional apps. Read cache evidence must never skip that check.
    const pendingId = cacheId + (mutation ? ":write" : ":read");
    if (!mutation && pending.has(pendingId)) return pending.get(pendingId);
    const load = (async () => {
      const definition = catalog[kind] || mediaDefinitions[kind];
      const type = kind === "gc_detail" ? "gameCenterDetails" : kind === "version" ? "appStoreVersions" : definition.type;
      const base = kind === "gc_detail" || kind === "version" ? "/v1/" + type : api(kind);
      let relation = kind === "gc_detail" || kind === "version" ? "app" : definition.relation;
      const include = definition?.root ? "gameCenterDetail,gameCenterGroup" :
        kind === "gc_challenge_image" ? "localization,version" : relation;
      if (kind === "gc_challenge_image" && !cached(app, kind, id)) {
        throw new PublicError("Challenge image ownership requires its parent localization or version.");
      }
      const resource = (mutation && definition?.root ? undefined : cached(app, kind, id)) || assertResource(
        (await request(base + "/" + id + "?include=" + include))?.data, type, id
      );
      if (definition?.root && resource.relationships?.gameCenterGroup?.data) {
        const group = resource.relationships.gameCenterGroup.data;
        if (group.type !== "gameCenterGroups" || !resourceId.safeParse(group.id).success) throw new PublicError("Could not establish shared Game Center ownership.");
        await groupOwnership(app, group.id, mutation);
      } else {
        let parentKind = kind === "gc_detail" || kind === "version" ? "app" : definition.parent;
        if (kind === "gc_challenge_image" && !resource.relationships?.localization?.data) {
          relation = "version";
          parentKind = "gc_challenge_version";
        }
        const parent = resource.relationships?.[relation]?.data;
        const parentType = parentKind === "app" ? "apps" : parentKind === "gc_detail" ? "gameCenterDetails" : parentKind === "version" ? "appStoreVersions" : catalog[parentKind].type;
        if (parent?.type !== parentType || !resourceId.safeParse(parent.id).success) {
          throw new PublicError("Could not establish resource ownership.");
        }
        await verify(app, parentKind, parent.id, mutation, depth + 1);
      }
      remember(app, kind, resource);
      return resource;
    })();
    // Mutation authorization depends on the individual caller's operation.
    // Only read-only ownership work can share an in-flight promise.
    if (!mutation) pending.set(pendingId, load);
    try { return await load; } finally { if (!mutation) pending.delete(pendingId); }
  }

  async function detail(app) {
    const existing = cached(app, "gc_detail", app);
    if (existing) return existing;
    const resource = assertResource((await request("/v1/apps/" + app + "/gameCenterDetail?include=gameCenterGroup"))?.data, "gameCenterDetails");
    // The app-scoped endpoint establishes this exact ownership edge.
    const normalized = { ...resource, relationships: { ...resource.relationships, app: { data: { type: "apps", id: app } } } };
    remember(app, "gc_detail", normalized);
    cache.set(key(app, "gc_detail", app), { resource: normalized, expires: now() + 600_000 });
    return normalized;
  }

  async function list(app, kind, parentId) {
    const definition = catalog[kind];
    let parent;
    let base;
    if (definition.root) {
      parent = await detail(app);
      const group = parent.relationships?.gameCenterGroup?.data;
      if (group) {
        if (group.type !== "gameCenterGroups" || !resourceId.safeParse(group.id).success) throw new PublicError("Could not establish shared Game Center ownership.");
        await groupOwnership(app, group.id, false);
        parent = { type: "gameCenterGroups", id: group.id };
        base = "/v1/gameCenterGroups";
      } else base = "/v1/gameCenterDetails";
    } else if (definition.parent === "app") {
      parent = { id: app };
      base = "/v1/apps";
    } else {
      parent = await verify(app, definition.parent, parentId);
      base = definition.parent === "version" ? "/v1/appStoreVersions" : api(definition.parent);
    }
    const items = await collection(base + "/" + parent.id + "/" + definition.collection);
    for (const resource of items) {
      assertResource(resource, definition.type);
      // Only the specific collection's documented parent edge is inferred.
      const normalized = { ...resource, relationships: {
        ...resource.relationships,
        [definition.relation]: { data: { type: definition.parent === "app" ? "apps" : parent.type, id: parent.id } }
      } };
      if (definition.root) {
        // Fetch full parent relationships on first use, including group scope.
        continue;
      }
      remember(app, kind, normalized);
    }
    return items.map(resource => projectExpanded(resource, kind));
  }

  async function create(app, kind, input) {
    const definition = catalog[kind];
    let parent;
    let parentKind = definition.parent;
    if (definition.root) {
      parent = await detail(app);
      const group = parent.relationships?.gameCenterGroup?.data;
      if (group) {
        if (group.type !== "gameCenterGroups" || !resourceId.safeParse(group.id).success) throw new PublicError("Could not establish shared Game Center ownership.");
        await groupOwnership(app, group.id, true);
        if (!input.attributes.vendorIdentifier.startsWith("grp.")) throw new PublicError("A grouped Game Center identifier must begin with grp.");
        parent = { type: "gameCenterGroups", id: group.id };
      }
    } else parent = await verify(app, parentKind, input.parent_id, true);
    const parentRelation = parent.type === "gameCenterGroups" ? "gameCenterGroup" : definition.relation;
    const relationships = { [parentRelation]: { data: { type: parent.type, id: parent.id } } };
    const payload = { data: { type: definition.type, relationships } };
    if (input.attributes && Object.keys(input.attributes).length) payload.data.attributes = input.attributes;
    if (kind === "gc_challenge") {
      await verify(app, "gc_leaderboard", input.leaderboard_id, true);
      relationships.leaderboardV2 = { data: { type: catalog.gc_leaderboard.type, id: input.leaderboard_id } };
    }
    if (definition.root && kind !== "gc_challenge") {
      const versionType = catalog[kind + "_version"].type;
      const temporaryId = "${" + randomUUID() + "}";
      relationships.versions = { data: [{ type: versionType, id: temporaryId }] };
      payload.included = [{ type: versionType, id: temporaryId }];
    }
    const response = await request(api(kind), { method: "POST", body: payload });
    const created = assertResource(response?.data, definition.type);
    remember(app, kind, { ...created, relationships: {
      ...created.relationships, ...relationships
    } });
    return projectExpanded(created, kind);
  }

  async function media(app, localizationId) {
    await verify(app, "version_localization", localizationId);
    const base = "/v1/appStoreVersionLocalizations/" + localizationId;
    const placements = await collection(base + "/placements");
    const fields = ["placementType", "placementGroup", "mediaType", "state", "createdDate"];
    const output = placements.map(resource => {
      assertResource(resource, "appAssetLibraryPlacements");
      const row = { id: resource.id };
      for (const field of fields) if (typeof resource.attributes?.[field] === "string") row[field] = resource.attributes[field];
      return row;
    });
    const legacy = {};
    for (const [sets, field, children] of [
      ["appScreenshotSets", "screenshotDisplayType", "appScreenshots"],
      ["appPreviewSets", "previewType", "appPreviews"]
    ]) {
      legacy[sets] = [];
      for (const set of await collection(base + "/" + sets)) {
        assertResource(set, sets);
        const assets = await collection("/v1/" + sets + "/" + set.id + "/" + children);
        legacy[sets].push({ id: set.id, [field]: set.attributes?.[field], assets: assets.map(asset => {
          assertResource(asset, children);
          return { id: asset.id, fileName: asset.attributes?.fileName, state: asset.attributes?.assetDeliveryState?.state };
        }) });
      }
    }
    return { placements: output, ...legacy };
  }

  const call = async (alias, operation, raw) => {
    if (typeof alias !== "string" || !Object.hasOwn(apps, alias)) throw new PublicError("Unknown app alias.");
    if (uploads?.has(operation)) {
      return uploads.call(alias, apps[alias], operation, raw, { verify, request, invalidate });
    }
    const entry = operations.get(operation);
    if (!entry) throw new PublicError("Unknown operation.");
    const parsed = expandedTools[operation][1].safeParse(raw);
    if (!parsed.success) throw new PublicError("Invalid operation arguments.");
    const input = parsed.data;
    const app = apps[alias];
    const { kind, action } = entry;
    if (action === "image") {
      await verify(app, kind, input.localization_id);
      const response = await request(api(kind) + "/" + input.localization_id + "/image");
      return response.data ? projectExpanded(response.data, kind.replace("_localization", "_image")) : null;
    }
    if (action === "detail") {
      const resource = await detail(app);
      return { id: resource.id, arcadeEnabled: resource.attributes?.arcadeEnabled, challengeEnabled: resource.attributes?.challengeEnabled };
    }
    if (action === "media") return media(app, input.localization_id);
    if (action === "defaultImage") {
      await verify(app, "gc_challenge_version", input.version_id);
      const response = await request("/v1/gameCenterChallengeVersions/" + input.version_id + "/defaultImage");
      return response.data ? projectExpanded(response.data, "gc_challenge_image") : null;
    }
    if (kind === "gc_challenge_image") {
      const parentKind = "gc_challenge_" + input.parent_kind;
      const parent = await verify(app, parentKind, input.parent_id, action === "delete");
      const relationship = input.parent_kind === "version" ? "defaultImage" : "image";
      const resource = assertResource((await request(api(parentKind) + "/" + parent.id + "/" + relationship))?.data, catalog[kind].type, input.id);
      remember(app, kind, { ...resource, relationships: {
        [input.parent_kind]: { data: { type: parent.type, id: parent.id } }
      } });
    }
    if (action === "list") return list(app, kind, input.parent_id);
    if (action === "get") return projectExpanded(await verify(app, kind, input.id), kind);
    if (action === "create") return create(app, kind, input);
    await verify(app, kind, input.id, true);
    if (action === "delete") {
      await request(api(kind) + "/" + input.id, { method: "DELETE" });
      invalidate();
      return { deleted: true };
    }
    const payload = { data: { id: input.id, type: catalog[kind].type, attributes: input.attributes } };
    if (input.leaderboard_id) {
      await verify(app, "gc_leaderboard", input.leaderboard_id, true);
      payload.data.relationships = { leaderboardV2: { data: { type: catalog.gc_leaderboard.type, id: input.leaderboard_id } } };
    }
    const response = await request(api(kind) + "/" + input.id, { method: "PATCH", body: payload });
    cache.delete(key(app, kind, input.id));
    return response?.data ? projectExpanded(response.data, kind) : { updated: true };
  };
  call.verifyResource = verify;
  return call;
}
