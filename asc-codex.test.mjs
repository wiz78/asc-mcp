import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { createAppleClient, createDaemon } from "./asc-daemon.mjs";
import { createFixture } from "./asc-fixture.mjs";

function png(width, height) {
  // Valid RGB PNG with CRCs, compressed without external image tools.
  const crc = bytes => {
    let sum = 0xffffffff;
    for (const byte of bytes) {
      sum ^= byte;
      for (let bit = 0; bit < 8; bit++) sum = (sum >>> 1) ^ ((sum & 1) ? 0xedb88320 : 0);
    }
    return (sum ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    const output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length);
    data.copy(output, 4);
    output.writeUInt32BE(crc(data), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}

class Codex {
  constructor(socket) {
    const bridge = fileURLToPath(new URL("./asc-bridge.mjs", import.meta.url));
    this.child = spawn("codex", [
      "-c", "mcp_servers.asc_candidate.command=" + JSON.stringify(process.execPath),
      "-c", "mcp_servers.asc_candidate.args=" + JSON.stringify([bridge, "fixture", socket]),
      "app-server", "--stdio"
    ], { stdio: ["pipe", "pipe", "ignore"] });
    this.pending = new Map();
    this.sequence = 0;
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      const message = JSON.parse(line);
      if (message.method && message.id) {
        this.send({ id: message.id, error: { code: -32601, message: "Unsupported test request" } });
        return;
      }
      const promise = this.pending.get(message.id);
      if (!promise) return;
      this.pending.delete(message.id);
      clearTimeout(promise.timer);
      if (message.error) promise.reject(new Error("Codex protocol error " + message.error.code));
      else promise.resolve(message.result);
    });
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Timed out: " + method)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async call(tool, args) {
    const response = await this.request("mcpServer/tool/call", { threadId: this.thread, server: "asc_candidate", tool, arguments: args });
    assert.ok(!response.isError, tool + " failed: " + response.content?.[0]?.text);
    return JSON.parse(response.content[0].text);
  }
  async close() {
    this.lines.close();
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.child.kill();
    await once(this.child, "exit");
  }
}

test("Codex exercises candidate localization, Game Center CRUD, images and isolation before deployment", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp("/private/tmp/asc-codex-");
  const socket = join(directory, "candidate.sock");
  const fixture = createFixture();
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const apple = createAppleClient({
    ASC_KEY_ID: "SYNTHETIC1", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000001",
    ASC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" })
  }, fixture.fetch);
  apple.uploadFetch = fixture.uploadFetch;
  const server = createDaemon({ fixture: "123" }, apple);
  let codex;
  try {
    server.listen(socket);
    await once(server, "listening");
    codex = new Codex(socket);
    await codex.request("initialize", { clientInfo: { name: "asc_candidate_test", version: "1.0" }, capabilities: { experimentalApi: true } });
    codex.send({ method: "initialized" });
    const started = await codex.request("thread/start", { ephemeral: true, cwd: process.cwd(), approvalPolicy: "never" });
    codex.thread = started.thread.id;
    const inventory = await codex.request("mcpServerStatus/list", { threadId: codex.thread, serverName: "asc_candidate" });
    const tools = inventory.data.find(item => item.name === "asc_candidate").tools;
    assert.ok(Object.keys(tools).length > 60);
    assert.equal(tools.asc_exec, undefined);

    const info = (await codex.call("list_app_infos", {}))[0];
    const appLoc = await codex.call("create_app_info_localization", { parent_id: info.id, attributes: { locale: "it", name: "Fixture italiana", subtitle: "Prova", privacyPolicyUrl: "https://example.test/privacy" } });
    assert.equal((await codex.call("get_app_info_localization", { id: appLoc.id })).locale, "it");
    await codex.call("update_app_info_localization", { id: appLoc.id, attributes: { subtitle: "Aggiornata" } });
    const version = (await codex.call("list_versions", {}))[0];
    const versionLoc = await codex.call("create_version_localization", { parent_id: version.id, attributes: { locale: "it", description: "Descrizione", keywords: "biliardo", supportUrl: "https://example.test/support" } });
    assert.equal((await codex.call("get_version_localization", { id: versionLoc.id })).description, "Descrizione");
    await codex.call("update_version_localization", { localization_id: versionLoc.id, version_id: version.id, description: "Aggiornata" });
    assert.equal((await codex.call("list_version_media", { localization_id: versionLoc.id })).placements.length, 0);

    let leaderboard;
    for (const kind of ["leaderboard", "achievement", "challenge"]) {
      const attributes = kind === "achievement"
        ? { referenceName: "Fixture achievement", vendorIdentifier: "test.achievement", points: 10, repeatable: false, showBeforeEarned: true }
        : kind === "leaderboard"
          ? { referenceName: "Fixture leaderboard", vendorIdentifier: "test.leaderboard", defaultFormatter: "INTEGER", submissionType: "BEST_SCORE", scoreSortType: "DESC" }
          : { referenceName: "Fixture challenge", vendorIdentifier: "test.challenge", repeatable: true };
      const created = await codex.call("create_gc_" + kind, { attributes, ...(kind === "challenge" ? { leaderboard_id: leaderboard } : {}) });
      if (kind === "leaderboard") leaderboard = created.id;
      const component = "gc_" + kind;
      assert.ok((await codex.call("list_" + component + "s", {})).some(item => item.id === created.id));
      await codex.call("update_" + component, { id: created.id, attributes: { referenceName: "Updated fixture", archived: false } });
      let versions = await codex.call("list_" + component + "_versions", { parent_id: created.id });
      if (!versions.length) versions = [await codex.call("create_" + component + "_version", { parent_id: created.id, attributes: {} })];
      const localization = await codex.call("create_" + component + "_localization", {
        parent_id: versions[0].id,
        attributes: { locale: "it", name: "Prova italiana", ...(kind === "achievement" ? { beforeEarnedDescription: "Prima", afterEarnedDescription: "Dopo" } : { description: "Descrizione" }) }
      });
      await codex.call("update_" + component + "_localization", { id: localization.id, attributes: { name: "Aggiornata" } });
      assert.equal((await codex.call("list_" + component + "_localizations", { parent_id: versions[0].id }))[0].name, "Aggiornata");

      const image = join(directory, kind + ".png");
      await writeFile(image, png(kind === "challenge" ? 3840 : 1024, kind === "challenge" ? 2160 : 1024));
      const upload = await codex.call("upload_game_center_image", { target: kind + "_localization", parent_id: localization.id, file_path: image });
      assert.equal(upload.assetDeliveryState.state, "COMPLETE");
      assert.equal((await codex.call("get_" + component + "_localization_image", { localization_id: localization.id })).id, upload.asset_id);
      await codex.call("delete_" + component + "_image", { id: upload.asset_id, ...(kind === "challenge" ? { parent_id: localization.id, parent_kind: "localization" } : {}) });
      if (kind === "challenge") {
        const defaultImage = await codex.call("upload_game_center_image", { target: "challenge_version", parent_id: versions[0].id, file_path: image });
        assert.equal((await codex.call("get_gc_challenge_default_image", { version_id: versions[0].id })).id, defaultImage.asset_id);
        await codex.call("delete_gc_challenge_image", { id: defaultImage.asset_id, parent_id: versions[0].id, parent_kind: "version" });
      }
      await codex.call("delete_" + component + "_localization", { id: localization.id });
      // Leaderboard remains until its dependent challenge has been exercised.
      if (kind !== "leaderboard") await codex.call("delete_" + component, { id: created.id });
    }
    await codex.call("delete_gc_leaderboard", { id: leaderboard });
    await codex.call("delete_app_info_localization", { id: appLoc.id });
    await codex.call("delete_version_localization", { id: versionLoc.id });
    assert.equal(fixture.uploads, 4);
    fixture.rejectNextLeaderboardCreate({
      code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
      title: "Invalid attribute",
      detail: "The vendor identifier is invalid for this request.",
      source: { pointer: "/data/attributes/vendorIdentifier" }
    });
    const conflict = await codex.request("mcpServer/tool/call", {
      threadId: codex.thread, server: "asc_candidate", tool: "create_gc_leaderboard",
      arguments: { attributes: {
        defaultFormatter: "INTEGER", referenceName: "8-ball Career v1",
        vendorIdentifier: "test.example.leaderboard.eightBall.career.v1",
        submissionType: "BEST_SCORE", scoreSortType: "DESC"
      } }
    });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /HTTP 409/);
    assert.match(conflict.content[0].text, /ENTITY_ERROR.ATTRIBUTE.INVALID/);
    assert.match(conflict.content[0].text, /vendor identifier is invalid/);
    assert.match(conflict.content[0].text, /\/data\/attributes\/vendorIdentifier/);
    assert.equal([...fixture.records.values()].some(item => item.attributes?.vendorIdentifier === "test.example.leaderboard.eightBall.career.v1"), false);
    const rejected = await codex.request("mcpServer/tool/call", { threadId: codex.thread, server: "asc_candidate", tool: "create_gc_achievement", arguments: { attributes: {}, app_id: "456" } });
    assert.equal(rejected.isError, true);
    console.log("Codex candidate verified localized CRUD, all three Game Center families, four image flows, sanitized HTTP 409 details and override rejection.");
  } finally {
    if (codex) await codex.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
