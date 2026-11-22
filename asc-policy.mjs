import { PublicError } from "./asc-errors.mjs";

function selector(value) {
  if (typeof value !== "string" || !value.trim()) throw new PublicError("Policy selectors must be nonempty strings.");
  const parts = value.trim().split(":");
  if (parts.length > 2) throw new PublicError("Invalid policy selector: " + value);
  let mode = "all";
  if (parts.length === 2) {
    mode = parts.shift();
    if (mode === "read-only") mode = "read";
    if (!["read", "write"].includes(mode)) throw new PublicError("Use read: or write: in policy selectors.");
  }
  let path = parts[0].replace(/\/\*\*$/, "").replaceAll("/", " ").trim().replace(/\s+/g, " ");
  if (path === "all") path = "*";
  if (path !== "*" && !/^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/.test(path)) throw new PublicError("Invalid policy selector: " + value);
  return { value, mode, path };
}

function subtree(path, prefix) {
  return path === prefix || path.startsWith(prefix + " ");
}

export function matches(rule, operation) {
  if (rule.mode !== "all" && rule.mode !== operation.mode) return false;
  if (rule.path === "*") return true;
  return operation.name === rule.path || subtree(operation.command, rule.path) ||
    subtree(operation.category + " " + operation.command, rule.path) ||
    operation.category === rule.path;
}

export function compilePolicy(policy, known) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).some(key => !["allow", "deny"].includes(key)) ||
      !Array.isArray(policy.allow) || (policy.deny !== undefined && !Array.isArray(policy.deny))) {
    throw new PublicError("A policy needs an allow array and an optional deny array.");
  }
  const allow = policy.allow.map(selector);
  const deny = (policy.deny || []).map(selector);
  for (const rule of [...allow, ...deny]) {
    if (!known.some(operation => matches({ ...rule, mode: "all" }, { ...operation, mode: "read" }))) {
      throw new PublicError("Unknown policy selector: " + rule.value);
    }
  }
  for (const rule of deny) {
    const executable = known.some(operation => operation.name && (
      matches({ ...rule, mode: "all" }, operation) ||
      operation.relatedPolicies?.some(domain => matches({ ...rule, mode: "all" }, { ...operation, ...domain }))
    ));
    if (!executable) {
      throw new PublicError("Deny selector has no executable operation mapping: " + rule.value + ". Use a broader family or an exact API tool name.");
    }
  }
  return operation => {
    const denied = deny.filter(rule => matches(rule, operation) ||
      operation.relatedPolicies?.some(domain => matches(rule, { ...operation, ...domain, mode: operation.mode }))).map(rule => rule.value);
    const allowed = allow.filter(rule => matches(rule, operation) ||
      operation.allowPolicies?.some(domain => matches(rule, { ...operation, ...domain, mode: operation.mode }))).map(rule => rule.value);
    return { allowed: allowed.length > 0 && denied.length === 0, allow: allowed, deny: denied };
  };
}

export function legacyDescriptor(name) {
  let command;
  if (["upload_screenshot", "upload_video_preview", "finish_media_upload", "cancel_media_upload"].includes(name)) {
    return {name, command: name === "upload_screenshot" ? "screenshots" : name === "upload_video_preview" ? "video-previews" : "asset-library uploads", mode:"write", category:"app-management", legacy:false, appOnly:true};
  }
  if (name.includes("gc_")) {
    const match = name.match(/gc_(achievement|leaderboard|challenge)/);
    command = "game-center " + (match ? match[1] + "s" : "");
    if (name.includes("image")) command += " images";
    else if (name.includes("localization")) command += " localizations";
    else if (name.includes("version")) command += " versions";
  } else if (name.includes("game_center_image")) command = "game-center images";
  else if (name.includes("game_center")) command = "game-center details";
  else if (name === "list_builds") command = "builds list";
  else if (name === "get_app") command = "apps view";
  else if (name === "list_versions") command = "versions list";
  else if (name.includes("app_info")) command = "localizations app-info";
  else if (name.includes("media")) command = "asset-library";
  else command = "localizations versions";
  const mode = /^(get_|list_)/.test(name) ? "read" : "write";
  return {
    name, command: command.trim(), mode, legacy: true,
    category: name === "list_builds" ? "testflight-and-build" : "app-management",
    relatedPolicies: name === "list_version_media" ? [
      { category: "app-management", command: "screenshots" },
      { category: "app-management", command: "video-previews" }
    ] : /^create_gc_(achievement|leaderboard)$/.test(name) ? [
      { category: "app-management", command: command + " versions" }
    ] : []
  };
}
