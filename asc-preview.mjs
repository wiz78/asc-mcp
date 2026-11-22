#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateConfiguration, operationInventory } from "./asc-runtime.mjs";
import { apiCatalog } from "./asc-catalog.mjs";

import { inspect } from "./asc-inspect.mjs";

export async function main(args) {
  if (["status", "tools"].includes(args[0])) return inspect(args[0], args.slice(1));
  const [command, file, scope] = args;
  if (command === "catalog") {
    console.log(JSON.stringify({
      apple: apiCatalog.source,
      operations: apiCatalog.operations.map(({ name, category, command, method, path }) => ({ name, category, command, method, path }))
    }, null, 2));
    return;
  }
  if (!["check", "explain"].includes(command) || !file) {
    console.error("Usage: asc-mcp-preview check CONFIG | explain CONFIG APP_ALIAS|--team | catalog | status APP_ALIAS|--team [--json] | tools APP_ALIAS|--team [--filter TEXT] [--json] [--socket PATH]");
    process.exitCode = 1;
    return;
  }
  const input = JSON.parse(await readFile(file, "utf8"));
  validateConfiguration(input);
  if (command === "check") console.log("Configuration and policy selectors are valid.");
  else {
    if (!scope) throw new Error("Choose an app alias or --team.");
    console.log(JSON.stringify(operationInventory(input, scope === "--team" ? "@team" : scope), null, 2));
  }
}
if (process.argv[1] && pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
