import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const launchctl = (...args) => execFileSync("/bin/launchctl", args, { encoding: "utf8" });
const escapeXml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const string = value => "<string>" + escapeXml(value) + "</string>";

test("launchd starts on demand, observes idle exit, and starts again", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp("/private/tmp/asc-launch-");
  const socket = join(dir, "asc.sock");
  const config = join(dir, "apps.json");
  const helper = join(dir, "activate-socket");
  const plist = join(dir, "job.plist");
  const label = "local.asc-scoped.test." + process.pid;
  const domain = "gui/" + process.getuid();
  const service = domain + "/" + label;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const program = [
    helper, process.execPath,
    fileURLToPath(new URL("../asc-daemon.mjs", import.meta.url)), config
  ];
  let registered = false;
  const pid = () => /^\s*pid = (\d+)$/m.exec(launchctl("print", service))?.[1];

  async function waitFor(getValue) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = getValue();
      if (value) return value;
      await delay(100);
    }
    assert.fail("Timed out waiting for launchd state");
  }

  const request = () => {
    const result = execFileSync("/usr/bin/curl", [
      "--silent", "--show-error", "--max-time", "12", "--unix-socket", socket,
      "--header", "Content-Type: application/json",
      "--data", '{"app":"example-app","operation":"invalid","input":{}}',
      "http://localhost/call"
    ], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(result), { error: "Unknown operation." });
  };

  try {
    execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror",
      fileURLToPath(new URL("./activate-socket.c", import.meta.url)), "-o", helper]);
    await writeFile(config, JSON.stringify({ apps: { "example-app": "123" }, idleTimeoutMs: 1_000 }));
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict>
        <key>Label</key>${string(label)}
        <key>ProgramArguments</key><array>${program.map(string).join("")}</array>
        <key>EnvironmentVariables</key><dict>
          <key>ASC_KEY_ID</key><string>SYNTHETIC1</string>
          <key>ASC_ISSUER_ID</key><string>00000000-0000-0000-0000-000000000001</string>
          <key>ASC_PRIVATE_KEY</key>${string(privateKey.export({ type: "pkcs8", format: "pem" }))}
        </dict>
        <key>Sockets</key><dict><key>ASCListener</key><dict>
          <key>SockPathName</key>${string(socket)}
          <key>SockPathGroup</key><integer>${process.getgid()}</integer>
          <key>SockPathMode</key><integer>432</integer>
        </dict></dict>
        <key>ThrottleInterval</key><integer>1</integer>
      </dict></plist>`, { mode: 0o600 });
    launchctl("bootstrap", domain, plist);
    registered = true;
    const listener = await waitFor(() => statSync(socket, { throwIfNoEntry: false })).catch(error => {
      throw new Error("The launchd socket did not appear.", { cause: error });
    });
    assert.ok(listener.isSocket());
    assert.equal(listener.mode & 0o777, 0o660);
    assert.equal(listener.gid, process.getgid());
    await waitFor(() => !pid());
    await delay(500);
    assert.equal(pid(), undefined, "an idle job should stay stopped before a request");

    request();
    const first = await waitFor(pid);
    await waitFor(() => !pid());
    assert.equal((await stat(socket)).ino, listener.ino, "launchd should retain the listener");

    request();
    const second = await waitFor(pid);
    assert.notEqual(second, first);
    await waitFor(() => !pid());
  } finally {
    if (registered) launchctl("bootout", service);
    await rm(dir, { recursive: true, force: true });
  }
});
