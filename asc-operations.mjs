import { z } from "zod";
import { expandedTools, createExpandedOperations } from "./asc-expanded.mjs";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().max(4000);
const fields = {
  apps: ["name", "bundleId", "sku", "primaryLocale"],
  appStoreVersions: ["versionString", "platform", "appStoreState", "appVersionState"],
  appStoreVersionLocalizations: ["locale", "description", "keywords", "marketingUrl", "supportUrl", "promotionalText", "whatsNew"],
  builds: ["version", "uploadedDate", "processingState", "expired"]
};

export const tools = {
  ...expandedTools,
  get_app: ["Read the configured app.", z.strictObject({})],
  list_versions: ["List App Store versions for the configured app.", z.strictObject({})],
  list_builds: ["List builds for the configured app.", z.strictObject({})],
  list_version_localizations: ["List metadata localizations for a version of the configured app.", z.strictObject({ version_id: id })],
  update_version_localization: [
    "Update metadata for a localization of the configured app. Supply the parent version ID when the localization has not been listed recently.",
    z.strictObject({
      localization_id: id,
      version_id: id.optional(),
      description: text.optional(),
      keywords: z.string().max(100).optional(),
      marketingUrl: z.string().max(2048).optional(),
      supportUrl: z.string().max(2048).optional(),
      promotionalText: z.string().max(170).optional(),
      whatsNew: text.optional()
    })
  ]
};

import { PublicError } from "./asc-errors.mjs";
export { PublicError } from "./asc-errors.mjs";

function project(resource, type) {
  if (resource?.type !== type || !id.safeParse(resource.id).success) {
    throw new PublicError("Unexpected App Store Connect response.");
  }
  const result = { id: resource.id };
  for (const field of fields[type]) {
    const value = resource.attributes?.[field];
    if (typeof value === "string" || typeof value === "boolean") result[field] = value;
  }
  return result;
}

export function createOperations(apps, request, { now = Date.now, uploads, authorizeShared } = {}) {
  const expanded = createExpandedOperations(apps, request, { now, uploads, authorizeShared });
  const cache = new Map();
  const pending = new Map();
  const versions = "appStoreVersions";
  const localizations = "appStoreVersionLocalizations";
  const origin = "https://api.appstoreconnect.apple.com";
  const cacheKey = (app, type, resourceId) => JSON.stringify([app, type, resourceId]);

  function remember(app, type, resourceId, parent = null) {
    const key = cacheKey(app, type, resourceId);
    cache.delete(key);
    cache.set(key, { until: now() + 10 * 60_000, parent });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value);
  }

  function lookup(app, type, resourceId) {
    const key = cacheKey(app, type, resourceId);
    const entry = cache.get(key);
    if (entry && entry.until > now()) return entry;
    cache.delete(key);
  }

  async function list(app, path, type, parent = null) {
    const key = cacheKey(app, type, path);
    if (pending.has(key)) return pending.get(key);
    const load = (async () => {
      const result = [];
      let next = path + "?limit=200";
      for (let page = 0; next && page < 20; page++) {
        const response = await request(next);
        if (!Array.isArray(response?.data)) throw new PublicError("Unexpected App Store Connect response.");
        result.push(...response.data.map(resource => project(resource, type)));
        next = null;
        if (response.links?.next) {
          const url = new URL(response.links.next, origin);
          if (url.origin !== origin || url.pathname !== path || url.username || url.password) {
            throw new PublicError("Unexpected App Store Connect pagination.");
          }
          next = url.pathname + url.search;
        }
      }
      if (next) throw new PublicError("App Store Connect collection exceeds the page limit.");
      for (const resource of result) remember(app, type, resource.id, parent);
      return result;
    })();
    pending.set(key, load);
    try {
      return await load;
    } finally {
      pending.delete(key);
    }
  }

  async function requireVersion(app, versionId) {
    if (lookup(app, versions, versionId)) return;
    const key = cacheKey(app, versions, versionId);
    if (pending.has(key)) return pending.get(key);
    const check = (async () => {
      const response = await request(`/v1/${versions}/${versionId}?include=app`);
      const resource = response?.data;
      const owner = resource?.relationships?.app?.data;
      if (resource?.id !== versionId || resource?.type !== versions || owner?.type !== "apps" || owner.id !== app) {
        throw new PublicError("Could not establish version ownership for this app.");
      }
      remember(app, versions, versionId);
    })();
    pending.set(key, check);
    try {
      await check;
    } finally {
      pending.delete(key);
    }
  }

  async function listLocalizations(app, versionId) {
    await requireVersion(app, versionId);
    return list(app, `/v1/${versions}/${versionId}/${localizations}`, localizations, versionId);
  }

  async function updateLocalization(app, input) {
    const { localization_id: localizationId, version_id: versionId, ...attributes } = input;
    if (!Object.keys(attributes).length) throw new PublicError("Supply at least one metadata field.");
    const cached = lookup(app, localizations, localizationId);
    if (!cached || (versionId && cached.parent !== versionId)) {
      if (!versionId) throw new PublicError("Could not establish localization ownership. Supply its version ID or list its localizations.");
      const resources = await listLocalizations(app, versionId);
      if (!resources.some(resource => resource.id === localizationId)) {
        throw new PublicError("Could not establish localization ownership for this version.");
      }
    }
    await request(`/v1/${localizations}/${localizationId}`, {
      method: "PATCH",
      body: { data: { id: localizationId, type: localizations, attributes } }
    });
    return { updated: true };
  }

  return async (alias, operation, rawInput) => {
    if (typeof alias !== "string" || !Object.hasOwn(apps, alias)) throw new PublicError("Unknown app alias.");
    if (Object.hasOwn(expandedTools, operation) || uploads?.has(operation)) return expanded(alias, operation, rawInput);
    if (typeof operation !== "string" || !Object.hasOwn(tools, operation)) throw new PublicError("Unknown operation.");
    const parsed = tools[operation][1].safeParse(rawInput);
    if (!parsed.success) throw new PublicError("Invalid operation arguments.");
    const app = apps[alias];
    const input = parsed.data;
    switch (operation) {
      case "get_app": {
        const resource = (await request(`/v1/apps/${app}`))?.data;
        if (resource?.id !== app) throw new PublicError("Unexpected App Store Connect response.");
        return project(resource, "apps");
      }
      case "list_versions":
        return list(app, `/v1/apps/${app}/${versions}`, versions);
      case "list_builds":
        return list(app, `/v1/apps/${app}/builds`, "builds");
      case "list_version_localizations":
        return listLocalizations(app, input.version_id);
      case "update_version_localization":
        return updateLocalization(app, input);
    }
  };
}
