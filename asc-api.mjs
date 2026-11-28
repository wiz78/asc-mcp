import { z } from "zod";
import { apiCatalog, apiOperations } from "./asc-catalog.mjs";
import { operationSchema, schemaCompiler } from "./asc-schema.mjs";
import { createExpandedOperations } from "./asc-expanded.mjs";
import legacyResources from "./asc-resource-catalog.json" with { type: "json" };
import { PublicError } from "./asc-errors.mjs";

const resourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const references = new Set(["territories", "appCategories"]);
const parents = {
  appStoreVersions: ["app", "apps"], appInfos: ["app", "apps"],
  appInfoLocalizations: ["appInfo", "appInfos"],
  appStoreVersionLocalizations: ["appStoreVersion", "appStoreVersions"],
  appScreenshotSets: ["appStoreVersionLocalization", "appStoreVersionLocalizations"],
  appScreenshots: ["appScreenshotSet", "appScreenshotSets"],
  appPreviewSets: ["appStoreVersionLocalization", "appStoreVersionLocalizations"],
  appPreviews: ["appPreviewSet", "appPreviewSets"],
  builds: ["app", "apps"], preReleaseVersions: ["app", "apps"],
  betaGroups: ["app", "apps"], betaAppLocalizations: ["app", "apps"],
  betaBuildLocalizations: ["build", "builds"], buildBetaDetails: ["build", "builds"],
  betaAppReviewDetails: ["app", "apps"], betaLicenseAgreements: ["app", "apps"],
  appStoreReviewDetails: ["appStoreVersion", "appStoreVersions"],
  appStoreReviewAttachments: ["appStoreReviewDetail", "appStoreReviewDetails"],
  appPriceSchedules: ["app", "apps"], appAvailabilityV2: ["app", "apps"],
  territoryAvailabilities: ["appAvailability", "appAvailabilityV2"],
  appPricePoints: ["app", "apps"],
  inAppPurchases: ["app", "apps"], inAppPurchaseLocalizations: ["inAppPurchase", "inAppPurchases"],
  inAppPurchasePriceSchedules: ["inAppPurchase", "inAppPurchases"],
  subscriptionGroups: ["app", "apps"], subscriptions: ["group", "subscriptionGroups"],
  subscriptionLocalizations: ["subscription", "subscriptions"],
  subscriptionGroupLocalizations: ["subscriptionGroup", "subscriptionGroups"],
  appEvents: ["app", "apps"], appEventLocalizations: ["appEvent", "appEvents"],
  appCustomProductPages: ["app", "apps"],
  appCustomProductPageVersions: ["appCustomProductPage", "appCustomProductPages"],
  appCustomProductPageLocalizations: ["appCustomProductPageVersion", "appCustomProductPageVersions"],
  appClips: ["app", "apps"], appClipDefaultExperiences: ["appClip", "appClips"],
  appClipDefaultExperienceLocalizations: ["appClipDefaultExperience", "appClipDefaultExperiences"],
  accessibilityDeclarations: ["app", "apps"], endUserLicenseAgreements: ["app", "apps"],
  appStoreVersionPhasedReleases: ["appStoreVersion", "appStoreVersions"],
  reviewSubmissions: ["app", "apps"], reviewSubmissionItems: ["reviewSubmission", "reviewSubmissions"],
  customerReviews: ["app", "apps"], customerReviewResponses: ["review", "customerReviews"],
  appAssetLibraryPlacements: ["appStoreVersionLocalization", "appStoreVersionLocalizations"]
};
const legacyKinds = new Map(Object.entries(legacyResources).map(([kind, resource]) => [resource.type, kind]));
const compile = schemaCompiler(apiCatalog.schemas);
const inputSchemas = new Map();
export function apiInputSchema(operation) {
  if (!inputSchemas.has(operation.name)) inputSchemas.set(operation.name, operationSchema(operation, compile));
  return inputSchemas.get(operation.name);
}

export function appOperationAvailable(operation) {
  if (operation.resourceType === "apps") {
    return operation.method === "GET" || operation.path.includes("/{id}");
  }
  return references.has(operation.resourceType) || legacyKinds.has(operation.resourceType) ||
    Object.hasOwn(parents, operation.resourceType) || operation.resourceType === "gameCenterDetails" ||
    operation.resourceType === "nominations";
}

function verifyNominationApps(app, relationship) {
  const data = relationship?.data;
  const paging = relationship?.meta?.paging;
  if (!Array.isArray(data) || !data.length || relationship.links?.next ||
      paging?.nextCursor || (paging?.total !== undefined && paging.total !== data.length) ||
      (data.length >= Math.min(50, paging?.limit ?? 50) && paging?.total === undefined)) {
    throw new PublicError("Could not establish complete nomination ownership.");
  }
  for (const parent of data) {
    if (parent?.type !== "apps" || !resourceId.safeParse(parent.id).success) {
      throw new PublicError("Could not establish nomination ownership.");
    }
    if (parent.id !== app) throw new PublicError("Nomination belongs to a different app or is shared across apps. Use team scope.");
  }
}

function cleanResponse(value) {
  if (Array.isArray(value)) return value.map(cleanResponse);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if ([...url.searchParams.keys()].some(key => /signature|token|credential|authorization/i.test(key))) return "[redacted URL]";
      } catch { return "[invalid URL]"; }
    }
    return value;
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:uploadOperations|assetToken|authorization|privateKey|privateKeyContent|accessToken|refreshToken|signedUrl)$/i.test(key)) continue;
    Object.defineProperty(output, key, { value: cleanResponse(child), enumerable: true, configurable: true });
  }
  return output;
}

export function createApiOperations(apps, request, { now = Date.now, authorizeShared } = {}) {
  const cache = new Map();
  const pending = new Map();
  const expanded = createExpandedOperations(apps, request, { now, authorizeShared });
  const getEndpoints = new Map();
  for (const operation of apiOperations.values()) {
    if (operation.method === "GET" && /^\/v\d+\/[^/]+\/\{id\}$/.test(operation.path)) {
      const current = getEndpoints.get(operation.resourceType);
      if (!current || Number(operation.path.split("/")[1].slice(1)) > Number(current.path.split("/")[1].slice(1))) getEndpoints.set(operation.resourceType, operation);
    }
  }

  async function own(app, type, id, mutation = false, depth = 0) {
    if (depth > 12 || !resourceId.safeParse(id).success) throw new PublicError("Could not establish resource ownership.");
    if (type === "apps") {
      if (id !== app) throw new PublicError("Resource belongs to a different app.");
      return;
    }
    if (references.has(type)) return;
    if (type === "nominations") {
      // Nominations have a to-many parent. Never cache this check: a shared
      // nomination must not become mutable through stale ownership evidence.
      const resource = (await request("/v1/nominations/" + encodeURIComponent(id) +
        "?include=relatedApps&fields%5Bnominations%5D=relatedApps&limit%5BrelatedApps%5D=50"))?.data;
      if (resource?.type !== type || resource.id !== id) throw new PublicError("Unexpected ownership response.");
      verifyNominationApps(app, resource.relationships?.relatedApps);
      return;
    }
    const kind = legacyKinds.get(type);
    if (kind?.startsWith("gc_") || type === "gameCenterDetails") {
      await expanded.verifyResource(app, kind || "gc_detail", id, mutation);
      return;
    }
    if (!Object.hasOwn(parents, type)) throw new PublicError("App ownership is not implemented for resource type " + type + ".");
    const key = JSON.stringify([app, type, id]);
    const item = cache.get(key);
    if (item?.until > now()) return;
    if (pending.has(key)) return pending.get(key);
    const check = (async () => {
      const operation = getEndpoints.get(type);
      if (!operation) throw new PublicError("No verified ownership endpoint for " + type + ".");
      const [relation, parentType] = parents[type];
      const include = operation.parameters.find(parameter => parameter.name === "include")?.schema?.items?.enum;
      const url = operation.path.replace("{id}", id) + (include?.includes(relation) ? "?include=" + relation : "");
      const resource = (await request(url))?.data;
      if (resource?.type !== type || resource.id !== id) throw new PublicError("Unexpected ownership response.");
      const parent = resource.relationships?.[relation]?.data;
      if (parent?.type !== parentType) throw new PublicError("Could not establish resource ownership.");
      await own(app, parentType, parent.id, mutation, depth + 1);
      cache.set(key, { until: now() + 600_000 });
      if (cache.size > 10000) cache.delete(cache.keys().next().value);
    })();
    pending.set(key, check);
    try { await check; } finally { pending.delete(key); }
  }

  async function checkReferences(app, body, mutation, linkage) {
    const inline = new Map();
    const records = [body?.data, ...(body?.included || [])].flat().filter(Boolean);
    const definitions = [...(linkage ? [] : [body?.data].flat()), ...(body?.included || [])].filter(Boolean);
    for (const record of definitions) {
      if (typeof record.id === "string" && /^\$\{[A-Za-z0-9_-]{1,128}\}$/.test(record.id)) {
        const key = record.type + "/" + record.id;
        if (inline.has(key)) throw new PublicError("Duplicate inline resource identifier.");
        inline.set(key, record);
      }
    }
    const checking = new Set();
    async function recordReferences(record) {
      if (!record || checking.has(record)) return;
      checking.add(record);
      for (const relationship of Object.values(record.relationships || {})) {
        for (const reference of [relationship?.data].flat().filter(Boolean)) {
          const local = inline.get(reference.type + "/" + reference.id);
          if (local) await recordReferences(local);
          else await own(app, reference.type, reference.id, mutation);
        }
      }
    }
    for (const record of records) {
      if (linkage && record.id && !inline.has(record.type + "/" + record.id)) await own(app, record.type, record.id, mutation);
      await recordReferences(record);
    }
  }

  async function scopeRequest(app, operation, input) {
    const pieces = operation.path.split("/");
    const type = operation.resourceType;
    const id = input.path?.id;
    const mutation = operation.method !== "GET";
    if (type === "nominations") {
      if (id) await own(app, type, id, mutation);
      else if (operation.method === "GET") {
        const supplied = input.query?.["filter[relatedApps]"];
        if (supplied && JSON.stringify(supplied) !== JSON.stringify([app])) throw new PublicError("App filter must match the selected app.");
        input.query = { ...input.query, "filter[relatedApps]": [app] };
      }
      const record = input.body?.data;
      if (record && (!id || Object.hasOwn(record.relationships || {}, "relatedApps"))) {
        verifyNominationApps(app, record.relationships?.relatedApps);
      }
    } else if (id) await own(app, type, id, mutation);
    else if (type === "apps" && operation.method === "GET") {
      const supplied = input.query?.["filter[id]"];
      if (supplied && JSON.stringify(supplied) !== JSON.stringify([app])) throw new PublicError("App filter must match the selected app.");
      input.query = { ...input.query, "filter[id]": [app] };
    } else if (mutation && input.body?.data && !Array.isArray(input.body.data)) {
      const record = input.body.data;
      if (record.type !== type) throw new PublicError("Unexpected resource type.");
      const relation = parents[type]?.[0] || legacyResources[legacyKinds.get(type)]?.relation;
      const parent = record.relationships?.[relation]?.data;
      if (!parent || Array.isArray(parent)) throw new PublicError("Creation requires a verified app-owned parent.");
      await own(app, parent.type, parent.id, true);
    } else if (!references.has(type)) {
      const parameter = operation.parameters.find(parameter => parameter.name === "filter[app]");
      if (!parameter || parents[type]?.[1] !== "apps") throw new PublicError("Use an app-owned parent endpoint for this collection.");
      const supplied = input.query?.["filter[app]"];
      if (supplied && JSON.stringify(supplied) !== JSON.stringify([app])) throw new PublicError("App filter must match the selected app.");
      input.query = { ...input.query, "filter[app]": [app] };
    }
    if (pieces.length > 4 && !id) throw new PublicError("A verified parent ID is required.");
    if (input.body) {
      const linkage = operation.path.includes("/relationships/");
      const record = input.body.data;
      if (!linkage && id && record && !Array.isArray(record) &&
          (record.type !== type || (record.id !== undefined && record.id !== id))) {
        throw new PublicError("Request body resource must match the verified path resource.");
      }
      for (const included of input.body.included || []) {
        if (included.id && !/^\$\{[A-Za-z0-9_-]{1,128}\}$/.test(included.id)) {
          await own(app, included.type, included.id, mutation);
        }
      }
      await checkReferences(app, input.body, mutation, linkage);
    }
    // Filtering by any other app-owned resource also requires evidence.
    for (const parameter of operation.parameters) {
      if (!parameter.name.startsWith("filter[")) continue;
      const values = input.query?.[parameter.name];
      if (!values || ["filter[id]", "filter[app]"].includes(parameter.name)) continue;
      const relationName = parameter.name.slice(7, -1);
      const relation = Object.values(parents).find(([name]) => name === relationName);
      if (relation) for (const value of [values].flat()) await own(app, relation[1], value);
    }
  }

  return async (scope, operation, raw) => {
    const parsed = apiInputSchema(operation).safeParse(raw);
    if (!parsed.success) throw new PublicError("Invalid API arguments for " + operation.name + ".");
    const input = parsed.data;
    if (scope.type === "app") {
      if (!appOperationAvailable(operation)) throw new PublicError("This operation requires explicit team scope.");
      await scopeRequest(scope.id, operation, input);
    }
    let path = operation.path;
    for (const [name, value] of Object.entries(input.path || {})) path = path.replace("{" + name + "}", encodeURIComponent(value));
    if (path.includes("{")) throw new PublicError("Missing API path parameter.");
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query || {})) {
      query.set(name, Array.isArray(value) ? value.join(",") : String(value));
    }
    if (query.size) path += "?" + query.toString();
    const response = await request(path, { method: operation.method, body: input.body });
    if (operation.method !== "GET") cache.clear();
    const result = cleanResponse(response ?? { completed: true });
    if (scope.type === "app") {
      if (operation.resourceType === "nominations" && operation.method === "GET") {
        const records = input.path?.id ? [result?.data] : result?.data;
        if (!Array.isArray(records)) throw new PublicError("Unexpected nomination response.");
        for (const record of records) {
          if (record?.type !== "nominations" || !resourceId.safeParse(record.id).success ||
              (input.path?.id && record.id !== input.path.id)) throw new PublicError("Unexpected nomination response.");
          if (record.relationships?.relatedApps) verifyNominationApps(scope.id, record.relationships.relatedApps);
          // Collection filters establish membership, not exclusive ownership.
          // Fetch canonical linkage independently of caller-selected fields.
          if (!input.path?.id) await own(scope.id, "nominations", record.id);
        }
      }
      // Included resources can cross a shared relationship. They never
      // establish ownership or become app-scoped output.
      if (result && typeof result === "object") delete result.included;
    }
    return result;
  };
}
