import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "../asc-runtime.mjs";
import { apiOperations } from "../asc-catalog.mjs";
import { apiInputSchema } from "../asc-api.mjs";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const modules = (await readdir(root)).filter(name => name.endsWith(".mjs") && name !== "asc-scoped-mcp.mjs");
for (const file of modules) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (result.status) process.exit(result.status);
}
for (const file of (await readdir(new URL("../launchd/", import.meta.url))).filter(name => name.endsWith(".sh"))) {
  const result = spawnSync("/bin/bash", ["-n", "launchd/" + file], { cwd: root, stdio: "inherit" });
  if (result.status) process.exit(result.status);
}
validateConfiguration(JSON.parse(await readFile(new URL("../examples/config.example.json", import.meta.url), "utf8")));
for (const operation of apiOperations.values()) {
  z.toJSONSchema(apiInputSchema(operation), { unrepresentable: "any", cycles: "ref", reused: "ref" });
}
console.log("Source syntax, examples and " + apiOperations.size + " MCP operation schemas checked.");
