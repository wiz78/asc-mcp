// Policy domains follow returned/linked resource types, not just the URL root.
export function resourceTypes(schema, schemas, seen = new Set()) {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return [];
    return resourceTypes(schemas[name], schemas, new Set([...seen, name]));
  }
  if (schema.properties?.data) return resourceTypes(schema.properties.data, schemas, seen);
  if (schema.items) return resourceTypes(schema.items, schemas, seen);
  if (schema.properties?.type?.enum) return schema.properties.type.enum;
  return [...new Set((schema.oneOf || schema.anyOf || schema.allOf || []).flatMap(value => resourceTypes(value, schemas, seen)))];
}

export function annotatePolicies(operations, schemas, commands) {
  const roots = new Map();
  for (const operation of operations) {
    if (/^\/v\d+\/[^/]+(?:\/\{id\})?$/.test(operation.path) && !roots.has(operation.resourceType)) roots.set(operation.resourceType, operation);
  }
  function family(type) {
    const gc = type.match(/^gameCenter(Achievement|LeaderboardSet|Leaderboard|Challenge)(.*)$/);
    let path;
    if (gc) {
      path = "game-center " + ({ Achievement: "achievements", Leaderboard: "leaderboards", LeaderboardSet: "leaderboard-sets", Challenge: "challenges" })[gc[1]];
      if (/Localization/.test(gc[2])) path += " localizations";
      else if (/Image/.test(gc[2])) path += " images";
      else if (/Version/.test(gc[2])) path += " versions";
    } else if (/^appAssetLibrary/.test(type)) path = "asset-library";
    else if (/^(appAvailability|territoryAvailabil)/.test(type)) path = "pricing availability";
    else if (/^appPriceSchedule|^appPrices$/.test(type)) path = "pricing schedule";
    else if (/^appPricePoint/.test(type)) path = "pricing price-points";
    else if (type === "territories") path = "pricing territories";
    else if (type === "appCategories") path = "categories";
    else if (/^appInfoLocaliz/.test(type)) path = "localizations app-info";
    else if (/^appStoreVersionLocaliz/.test(type)) path = "localizations versions";
    else if (/^appScreenshot/.test(type)) path = "screenshots";
    else if (/^appPreview/.test(type)) path = "video-previews";
    else path = roots.get(type)?.command.split(" ")[0];
    if (!path) return;
    const category = commands.find(command => command.path === path)?.category ||
      commands.find(command => path.startsWith(command.path + " "))?.category;
    if (!category) return;
    return { category, command: path };
  }

  for (const operation of operations) {
    const targetTypes = resourceTypes(operation.responseSchema || operation.requestBody, schemas);
    const domains = [operation.resourceType, ...targetTypes].map(family).filter(Boolean);
    const target = targetTypes.map(family).find(Boolean) || family(operation.resourceType);
    if (target) {
      operation.category = target.category;
      operation.command = target.command;
    }
    operation.policyResourceTypes = [...new Set([operation.resourceType, ...targetTypes])];
    operation.relatedPolicies = domains.filter(domain =>
      domain.command !== operation.command || domain.category !== operation.category);
  }
  return operations;
}
