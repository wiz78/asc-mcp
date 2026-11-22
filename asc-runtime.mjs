import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { tools, createOperations } from "./asc-operations.mjs";
import { bridgeUploadTools, mediaUploadTools } from "./asc-bridge-upload.mjs";
import { apiCatalog, apiOperations, knownCommands } from "./asc-catalog.mjs";
import { apiInputSchema, appOperationAvailable, createApiOperations } from "./asc-api.mjs";
import { compilePolicy, legacyDescriptor } from "./asc-policy.mjs";
import { parseConfiguration } from "./asc-config.mjs";
import { PublicError } from "./asc-errors.mjs";
import { resourceTypes } from "./asc-catalog-policy.mjs";

const legacyTools = { ...tools, ...bridgeUploadTools, ...mediaUploadTools };
const descriptors = new Map([
  ...Object.keys(legacyTools).map(name => [name, legacyDescriptor(name)]),
  ...apiOperations
]);
const known = [...knownCommands, ...descriptors.values()];

export function validateConfiguration(input) {
  const config = parseConfiguration(input);
  const policies = new Map();
  for (const [name, definition] of Object.entries(config.policies || {})) {
    policies.set(name, compilePolicy(definition, known));
  }
  return { config, policies };
}

export function operationInventory(input, alias) {
  const { config, policies } = validateConfiguration(input);
  const scope = getScope(config, alias);
  return [...descriptors.values()].map(operation => {
    const policy = config.legacy ? { allowed: !!operation.legacy, allow: ["legacy compatibility"], deny: [] } :
      (uploadNames.has(operation.name)
        ? summarizeTargets(operation.name, policies.get(scope.policy))
        : policies.get(scope.policy)(operation));
    const supported = (operation.legacy || operation.appOnly) ? scope.type === "app" :
      scope.type === "team" || appOperationAvailable(operation);
    return {
      name: operation.name, command: operation.command, category: operation.category,
      mode: operation.mode, allowed: policy.allowed && supported,
      policy, reason: supported ? undefined : "Requires explicit team scope or a resource ownership adapter."
    };
  });
}

function getScope(config, alias) {
  if (alias === "@team") {
    if (!config.team?.enabled) throw new PublicError("Team scope is disabled.");
    return { type: "team", policy: config.team.policy };
  }
  if (typeof alias !== "string" || !Object.hasOwn(config.apps, alias)) throw new PublicError("Unknown app alias.");
  const entry = config.apps[alias];
  return { type: "app", id: typeof entry === "string" ? entry : entry.id, policy: entry.policy };
}

const schemaJson = new Map();
function publicDefinition(name) {
  if (!schemaJson.has(name)) {
    const legacy = legacyTools[name];
    const operation = apiOperations.get(name);
    const schema = legacy ? legacy[1] : apiInputSchema(operation);
    const inputSchema = z.toJSONSchema(schema, { unrepresentable: "any", cycles: "ref", reused: "ref" });
    delete inputSchema.$schema;
    schemaJson.set(name, {
      name,
      description: legacy ? legacy[0] :
        operation.method + " " + operation.path + ". Category " + operation.category + "; command " + operation.command + ".",
      inputSchema
    });
  }
  return schemaJson.get(name);
}

const imageTargets = {
  achievement_localization: "game-center achievements images",
  leaderboard_localization: "game-center leaderboards images",
  challenge_localization: "game-center challenges images",
  challenge_version: "game-center challenges images",
  screenshot_set: "screenshots",
  preview_set: "video-previews"
};
const uploadNames = new Set([...Object.keys(bridgeUploadTools),...Object.keys(mediaUploadTools)]);
function targetsFor(name) {
  if(name === 'upload_screenshot') return ['screenshot_set'];
  if(name === 'upload_video_preview') return ['preview_set'];
  if(Object.hasOwn(mediaUploadTools,name)) return ['screenshot_set','preview_set'];
  return Object.keys(imageTargets).filter(target=>!['screenshot_set','preview_set'].includes(target));
}

function imageDescriptor(name, target) {
  const original = descriptors.get(name);
  return {
    ...original, command: imageTargets[target],
    allowPolicies: [original],
    relatedPolicies: [...(original.relatedPolicies || []), original]
  };
}

function summarizeTargets(name, policy) {
  const targets = Object.fromEntries(targetsFor(name).map(target => [target, policy(imageDescriptor(name, target))]));
  const permitted = Object.values(targets).filter(result => result.allowed);
  return {
    allowed: permitted.length > 0,
    allow: [...new Set(permitted.flatMap(result => result.allow))],
    deny: permitted.length ? [] : [...new Set(Object.values(targets).flatMap(result => result.deny))],
    targets
  };
}

function relatedOperation(operation, relation) {
  const types = resourceTypes(operation.responseSchema, apiCatalog.schemas);
  const version = operation.path.split("/")[1];
  for (const type of types) {
    const bases = [...apiOperations.values()].filter(candidate =>
      candidate.method === "GET" && candidate.resourceType === type &&
      /^\/v\d+\/[^/]+\/\{id\}$/.test(candidate.path));
    bases.sort((a, b) => Number(b.path.split("/")[1] === version) - Number(a.path.split("/")[1] === version));
    for (const base of bases) {
      const found = [...apiOperations.values()].find(candidate =>
        candidate.method === "GET" && candidate.path === base.path + "/" + relation);
      if (found) return found;
    }
  }
}

function bodyDomains(body) {
  const domains = new Set();
  function visit(record) {
    if (!record || typeof record !== "object") return;
    if (typeof record.type === "string") domains.add(record.type);
    for (const relationship of Object.values(record.relationships || {})) {
      for (const related of [relationship?.data].flat().filter(Boolean)) visit(related);
    }
  }
  for (const record of [body?.data, ...(body?.included || [])].flat().filter(Boolean)) visit(record);
  return [...domains].map(type => [...apiOperations.values()].find(candidate =>
    candidate.resourceType === type && /^\/v\d+\/[^/]+(?:\/\{id\})?$/.test(candidate.path))).filter(Boolean);
}

export function createRuntime(input, request, uploads) {
  const { config, policies } = validateConfiguration(input);
  const context = new AsyncLocalStorage();
  const authorizeShared = async ids => {
    if (config.legacy) return;
    const operation = context.getStore();
    if (!operation) throw new PublicError("Missing shared-resource policy context.");
    for (const id of ids) {
      const permitted = Object.entries(config.apps).some(([, entry]) =>
        entry.id === id && policies.get(entry.policy)(operation).allowed);
      if (!permitted) throw new PublicError("Shared Game Center mutation is denied by an affected app policy.");
    }
  };
  const legacy = createOperations(config.appIds, request, { uploads, authorizeShared });
  const api = createApiOperations(config.appIds, request, { authorizeShared });
  const definitionCache = new Map();

  function allowed(alias, name, target) {
    const scope = getScope(config, alias);
    const operation = descriptors.get(name);
    if (!operation) throw new PublicError("Unknown operation.");
    const supported = (operation.legacy || operation.appOnly) ? scope.type === "app" :
      scope.type === "team" || appOperationAvailable(operation);
    if (target && !targetsFor(name).includes(target)) throw new PublicError("Upload target does not match operation.");
    const candidates = uploadNames.has(name)
      ? (target ? [imageDescriptor(name, target)] : targetsFor(name).map(value => imageDescriptor(name, value)))
      : [operation];
    const permitted = config.legacy ? operation.legacy :
      candidates.some(candidate => policies.get(scope.policy)(candidate).allowed);
    if (!supported || !permitted) throw new PublicError("Operation is denied by the daemon policy.");
    return scope;
  }

  function definitions(alias) {
    getScope(config, alias);
    if (!definitionCache.has(alias)) {
      const result = [];
      for (const operation of descriptors.values()) {
        try { allowed(alias, operation.name); }
        catch (error) { if (error instanceof PublicError) continue; throw error; }
        result.push(publicDefinition(operation.name));
      }
      definitionCache.set(alias, result);
    }
    return definitionCache.get(alias);
  }

  return {
    config,
    definitions,
    async call(alias, name, args) {
      if (name === "_catalog") {
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new PublicError("Invalid catalog request.");
        return { tools: definitions(alias) };
      }
      if (uploads.has(name)) {
        const target = (name === "_image_begin" || name === "_media_begin") ? args?.target : uploads.sessionTarget(alias, args?.upload_id);
        let publicName;
        if (name.startsWith("_media_")) {
          publicName = name === "_media_cancel" ? "cancel_media_upload" :
            name === "_media_commit" ? "finish_media_upload" :
            target === "preview_set" ? "upload_video_preview" : "upload_screenshot";
        } else {
          publicName = name === "_image_cancel" ? "cancel_game_center_image_upload" :
            name === "_image_commit" ? "finish_game_center_image_upload" : "upload_game_center_image";
        }
        if (!Object.hasOwn(imageTargets, target)) throw new PublicError("Unknown or expired image upload target.");
        allowed(alias, publicName, target);
        return context.run(imageDescriptor(publicName, target), () => legacy(alias, name, args));
      }
      const scope = allowed(alias, name);
      if (apiOperations.has(name)) {
        const operation = apiOperations.get(name);
        const parsed = apiInputSchema(operation).safeParse(args);
        if (!parsed.success) throw new PublicError("Invalid API arguments for " + name + ".");
        const input = parsed.data;
        if (!config.legacy) {
          const policy = policies.get(scope.policy);
          for (const include of input.query?.include || []) {
            let parent = operation;
            for (const relation of include.split(".")) {
              const related = relatedOperation(parent, relation);
              if (!related || !policy({ ...related, mode: "read" }).allowed) {
                throw new PublicError("Included resource is denied by the daemon policy.");
              }
              parent = related;
            }
          }
          for (const domain of bodyDomains(input.body)) {
            if (policy({ ...domain, name, mode: operation.mode }).deny.length) {
              throw new PublicError("Request body resource domain is denied by the daemon policy.");
            }
          }
        }
        const effective = {
          ...operation,
          relatedPolicies: [...(operation.relatedPolicies || []), ...bodyDomains(input.body)]
        };
        return context.run(effective, () => api(scope, operation, input));
      }
      if (Object.hasOwn(bridgeUploadTools, name)) throw new PublicError("Use the bridge image transfer protocol.");
      let effective = descriptors.get(name);
      if (args?.leaderboard_id && /^create_gc_challenge$|^update_gc_challenge$/.test(name)) {
        effective = { ...effective, relatedPolicies: [...(effective.relatedPolicies || []),
          { category: "app-management", command: "game-center leaderboards" }] };
        if (!config.legacy && policies.get(scope.policy)(effective).deny.length) {
          throw new PublicError("Related leaderboard is denied by the daemon policy.");
        }
      }
      return context.run(effective, () => legacy(alias, name, args));
    }
  };
}
