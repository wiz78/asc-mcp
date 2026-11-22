import assert from "node:assert/strict";
import { test } from "node:test";
import { apiOperations } from "./asc-catalog.mjs";
import { createApiOperations } from "./asc-api.mjs";
import { createRuntime } from "./asc-runtime.mjs";
import { createUploads } from "./asc-uploads.mjs";

const operation = path => [...apiOperations.values()].find(item => item.path === path && item.method === "GET");
test("generated app listing injects the selected app and strips unrelated includes and upload credentials", async () => {
  const calls = [];
  const call = createApiOperations({ fixture: "123" }, async (path, options) => {
    calls.push(path);
    return { data: [{ type: "apps", id: "123", attributes: { name: "Fixture", uploadOperations: [{ url: "secret" }] } }], included: [{ type: "apps", id: "456" }] };
  });
  const result = await call({ type: "app", id: "123" }, operation("/v1/apps"), {});
  assert.match(calls[0], /filter%5Bid%5D=123/);
  assert.equal(result.included, undefined);
  assert.equal(result.data[0].attributes.uploadOperations, undefined);
  await assert.rejects(call({ type: "app", id: "123" }, operation("/v1/apps"), { query: { "filter[id]": ["456"] } }), /selected app/);
  assert.equal(calls.length, 1);
});

test("generated relationship writes cannot attach resources owned by a foreign app", async () => {
  let writes = 0;
  const call = createApiOperations({ fixture: "123" }, async (path, options) => {
    if (options?.method && options.method !== "GET") writes++;
    if (path.includes("betaGroups")) return { data: { type: "betaGroups", id: "group", relationships: { app: { data: { type: "apps", id: "123" } } } } };
    return { data: { type: "builds", id: "foreign", relationships: { app: { data: { type: "apps", id: "456" } } } } };
  });
  const op = apiOperations.get("api_betaGroups_builds_createToManyRelationship");
  await assert.rejects(call({ type: "app", id: "123" }, op, { path: { id: "group" }, body: { data: [{ type: "builds", id: "foreign" }] } }), /different app/);
  assert.equal(writes, 0);
});

test("policy enforcement applies to direct calls, schemas, disabled team and internal uploads", async () => {
  const uploads = createUploads();
  let requests = 0;
  try {
    const runtime = createRuntime({
      apps: { fixture: { id: "123", policy: "audit" } },
      policies: { audit: { allow: ["read:app-management"], deny: ["pricing"] } }
    }, async () => { requests++; }, uploads);
    const definitions = runtime.definitions("fixture");
    assert.ok(definitions.length > 0);
    assert.equal(definitions.some(item => item.name === "create_gc_achievement"), false);
    await assert.rejects(runtime.call("fixture", "create_gc_achievement", {}), /policy/);
    await assert.rejects(runtime.call("fixture", "_image_begin", { target: "achievement_localization" }), /policy/);
    await assert.rejects(runtime.call("@team", "api_users_getCollection", {}), /disabled/);
    await assert.rejects(runtime.call("fixture", "api_apps_getInstance", { path: { id: "456" }, credentials: "ignored?" }), /Invalid API/);
    assert.equal(requests, 0);
  } finally { uploads.close(); }
});

test("explicit team scope enables schema-backed account API operations only within its policy", async () => {
  const uploads = createUploads();
  try {
    let requests = 0;
    const runtime = createRuntime({
      apps: {}, team: { enabled: true, policy: "audit" },
      policies: { audit: { allow: ["read:users"] } }
    }, async path => { requests++; assert.equal(path, "/v1/users"); return { data: [] }; }, uploads);
    assert.deepEqual(await runtime.call("@team", "api_users_getCollection", {}), { data: [] });
    assert.equal(requests, 1);
    await assert.rejects(runtime.call("@team", "api_apps_getCollection", {}), /policy/);
    await assert.rejects(runtime.call("@team", "get_app", {}), /policy/);
  } finally { uploads.close(); }
});

test("family denies cover app relationship aliases and included resources", async () => {
  const uploads = createUploads();
  let calls = 0;
  try {
    const runtime = createRuntime({
      apps: { fixture: { id: "123", policy: "editor" } },
      team: { enabled: true, policy: "editor" },
      policies: { editor: { allow: ["*"], deny: ["pricing", "builds"] } }
    }, async () => { calls++; return { data: {} }; }, uploads);
    for (const name of ["api_apps_builds_getToManyRelated", "api_apps_appPriceSchedule_getToOneRelated"]) {
      await assert.rejects(runtime.call("fixture", name, { path: { id: "123" } }), /policy/);
      assert.equal(runtime.definitions("fixture").some(tool => tool.name === name), false);
    }
    await assert.rejects(runtime.call("@team", "api_apps_getInstance", {
      path: { id: "123" }, query: { include: ["builds"] }
    }), /policy/);
    assert.equal(calls, 0);
  } finally { uploads.close(); }
});

test("a mutation body cannot override the verified path resource ID", async () => {
  let writes = 0;
  const call = createApiOperations({ fixture: "123" }, async (path, options) => {
    if (options?.method && options.method !== "GET") writes++;
    return { data: { type: "appInfos", id: "owned", relationships: { app: { data: { type: "apps", id: "123" } } } } };
  });
  const op = [...apiOperations.values()].find(item => item.path === "/v1/appInfos/{id}" && item.method === "PATCH");
  await assert.rejects(call({ type: "app", id: "123" }, op, {
    path: { id: "owned" },
    body: { data: { id: "foreign", type: "appInfos" } }
  }), /match the verified path/);
  assert.equal(writes, 0);
});
