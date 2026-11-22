import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_cache: "/tmp/asc-npm-audit-cache" }
  });
  if (result.status !== 0) throw new Error(command + " failed: " + result.stderr);
  return result.stdout;
};
const packageFiles = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]))[0].files.map(file => file.path);
const tracked = run("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|\.codex|\.agents|\.claude|\.claude\.json|\.mcp\.json|CLAUDE\.local\.md|\.DS_Store|\.npmrc|\.netrc|\.op|node_modules|op-token|environment-id|apps\.json|.*\.local\.(?:json|ya?ml)|config\.local\..*|.*\.(?:p8|pem|key|p12|pfx|mobileprovision)|asc-scoped-mcp\.mjs)(?:\/|$)|docs\/(?:superpowers|.*design)/;
for (const path of new Set([...packageFiles, ...tracked])) {
  if (forbidden.test(path)) throw new Error("Private/generated file included: " + path);
  if (path.startsWith(".git/")) throw new Error("Git metadata included in package");
  const info = await stat(root + path);
  if (!info.isFile()) continue;
  const content = await readFile(root + path, "utf8");
  if (/\/Users\/[a-z][a-z0-9_-]*\/|-----BEGIN (?:EC |RSA )?PRIVATE KEY-----|ops_[A-Za-z0-9_-]{30,}/i.test(content)) {
    throw new Error("Personal configuration or credential material included: " + path);
  }
}
console.log("Audited " + tracked.length + " tracked and " + packageFiles.length + " package files.");
