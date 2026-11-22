import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAppleClient, createDaemon } from "./asc-daemon.mjs";

test("MCP bridge sees scoped data and withholds synthetic credentials", async () => {
  const path = await mkdtemp("/tmp/asc-test-");
  const socket = join(path, "asc.sock");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyId = "SYNTHETIC1";
  const fakeOpToken = "fake-service-account-token";
  const credentials = {
    ASC_KEY_ID: keyId,
    ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000001",
    ASC_PRIVATE_KEY_B64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"),
    OP_SERVICE_ACCOUNT_TOKEN: fakeOpToken
  };
  let mode = "normal";
  let calls = 0;
  const apple = createAppleClient(credentials, async (url, init) => {
    calls++;
    assert.equal(url.href, "https://api.appstoreconnect.apple.com/v1/apps/123");
    assert.equal(init.redirect, "error");
    const bearer = init.headers.Authorization.slice("Bearer ".length);
    const [header, claims, signature] = bearer.split(".");
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, keyId);
    assert.equal(JSON.parse(Buffer.from(claims, "base64url")).iss, credentials.ASC_ISSUER_ID);
    assert.ok(verify("sha256", Buffer.from(header + "." + claims), {
      key: publicKey, dsaEncoding: "ieee-p1363"
    }, Buffer.from(signature, "base64url")));
    if (mode === "throw") throw new Error(bearer + fakeOpToken);
    if (mode === "apple-error") return Response.json({ errors: [{
      code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
      title: "Invalid vendor identifier",
      detail: "The identifier conflicts. " + bearer + " " + fakeOpToken,
      source: { pointer: "/data/attributes/vendorIdentifier" },
      privateDebug: credentials.ASC_PRIVATE_KEY_B64
    }] }, { status: 409 });
    if (mode === "http") return new Response(bearer + fakeOpToken, { status: 403 });
    const reflected = { jwt: bearer, key: credentials.ASC_PRIVATE_KEY_B64, token: fakeOpToken };
    return Response.json({ data: { id: "123", type: "apps", attributes: {
      name: reflected[mode] || "Example App",
      unlistedField: fakeOpToken
    } } });
  });
  const server = createDaemon({ "example-app": "123" }, apple);
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    server.listen(socket);
    await once(server, "listening");
    assert.ok((await stat(socket)).isSocket());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./asc-bridge.mjs", import.meta.url)), "example-app", socket],
      env: {}
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 40);
    assert.ok(tools.every(tool => tool.description.startsWith("[example-app]")));
    const getApp = () => client.callTool({ name: "get_app", arguments: {} });
    const result = await getApp();
    assert.deepEqual(JSON.parse(result.content[0].text), { id: "123", name: "Example App" });
    assert.equal(calls, 1);
    for (mode of ["jwt", "key", "token", "throw", "http"]) {
      const error = await getApp();
      assert.equal(error.isError, true);
      assert.match(error.content[0].text, /^(Response withheld|App Store Connect request failed\.$|App Store Connect returned HTTP 403\.$)/);
    }
    assert.equal(calls, 6);
    mode = "apple-error";
    const diagnostic = await getApp();
    assert.equal(diagnostic.isError, true);
    const message = diagnostic.content[0].text;
    assert.match(message, /HTTP 409/);
    assert.match(message, /ENTITY_ERROR.ATTRIBUTE.INVALID/);
    assert.match(message, /The identifier conflicts/);
    assert.match(message, /\/data\/attributes\/vendorIdentifier/);
    for (const secret of [keyId, fakeOpToken, credentials.ASC_PRIVATE_KEY_B64, "eyJ"]) assert.equal(message.includes(secret), false);
    assert.equal(calls, 7);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(path, { recursive: true, force: true });
  }
});

test("MCP discovery follows daemon policy and direct hidden calls are denied", async () => {
  const directory = await mkdtemp("/private/tmp/asc-policy-mcp-");
  const socket = join(directory, "service.sock");
  let calls = 0;
  const server = createDaemon({
    apps: { fixture: { id: "123", policy: "audit" } },
    policies: { audit: { allow: ["read:pricing"] } }
  }, {
    mayReturn: () => true,
    request: async path => {
      calls++;
      assert.match(path, /^\/v1\/appPriceSchedules\/schedule/);
      return { data: {
        type: "appPriceSchedules", id: "schedule",
        relationships: { app: { data: { type: "apps", id: "123" } } }
      } };
    }
  });
  const client = new Client({ name: "policy-fixture", version: "1" });
  try {
    server.listen(socket);
    await once(server, "listening");
    await client.connect(new StdioClientTransport({
      command: process.execPath, env: {},
      args: [fileURLToPath(new URL("./asc-bridge.mjs", import.meta.url)), "fixture", socket]
    }));
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "api_appPriceSchedules_getInstance"));
    assert.equal(tools.some(tool => tool.name === "create_gc_achievement"), false);
    const result = await client.callTool({ name: "api_appPriceSchedules_getInstance", arguments: { path: { id: "schedule" } } });
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).data.id, "schedule");
    const before = calls;
    const denied = await client.callTool({ name: "create_gc_achievement", arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(calls, before);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge remains compatible with the installed legacy daemon protocol", async () => {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp("/private/tmp/asc-legacy-");
  const socket = join(directory, "service.sock");
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(input.operation === "_catalog"
      ? { error: "Unknown operation." }
      : { result: { id: "123", name: "Legacy fixture" } }));
  });
  const client = new Client({ name: "legacy-fixture", version: "1" });
  try {
    server.listen(socket);
    await once(server, "listening");
    await client.connect(new StdioClientTransport({
      command: process.execPath, env: {},
      args: [fileURLToPath(new URL("./asc-bridge.mjs", import.meta.url)), "fixture", socket]
    }));
    assert.equal((await client.listTools()).tools.length, 69);
    const result = await client.callTool({ name: "get_app", arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).name, "Legacy fixture");
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
