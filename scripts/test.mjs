import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(root)).filter(name => name.endsWith(".test.mjs") && name !== "asc-codex.test.mjs").sort();
files.push("launchd/installer.test.mjs");
const result = spawnSync(process.execPath, [
  "--import", "./tests/no-network.mjs", "--test", ...files
], { cwd: root, stdio: "inherit", env: { PATH: process.env.PATH } });
process.exitCode = result.status ?? 1;
