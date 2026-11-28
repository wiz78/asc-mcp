import assert from "node:assert/strict";
import { test } from "node:test";
import { apiOperations } from "./asc-catalog.mjs";
import { createApiOperations } from "./asc-api.mjs";
import { createRuntime } from "./asc-runtime.mjs";
import { createUploads } from "./asc-uploads.mjs";

const scope = { type: "app", id: "123" };
const op = action => apiOperations.get("api_nominations_" + action);
const nomination = (ids = ["123"]) => ({
  type: "nominations", id: "nom",
  relationships: { relatedApps: { data: ids.map(id => ({ type: "apps", id })) } }
});
const createBody = ids => ({ data: {
  type: "nominations",
  attributes: { name: "Launch", type: "APP_LAUNCH", description: "New app", submitted: false, publishStartDate: "2026-12-01T00:00:00Z" },
  relationships: nomination(ids).relationships
} });

test("nomination tools are discovered and callable with an app nominations policy", async () => {
  const uploads = createUploads();
  try {
    const runtime = createRuntime({ apps: { fixture: { id: "123", policy: "editor" } },
      policies: { editor: { allow: ["nominations"] } } }, async () => ({ data: nomination() }), uploads);
    const names = runtime.definitions("fixture").filter(tool => tool.name.startsWith("api_nominations_")).map(tool => tool.name);
    assert.equal(names.length, 5);
    assert.equal((await runtime.call("fixture", "api_nominations_getInstance", { path: { id: "nom" } })).data.id, "nom");
  } finally { uploads.close(); }
});

test("nomination listings inject relatedApps filter even with sparse fields", async () => {
  const calls = [];
  const call = createApiOperations({}, async path => {
    calls.push(path);
    if (path.startsWith("/v1/nominations/nom?")) return { data: nomination() };
    return { data: [{ type: "nominations", id: "nom", attributes: { name: "Launch" } }], included: [{ type: "apps", id: "456" }] };
  });
  const result = await call(scope, op("getCollection"), { query: { "filter[state]": ["DRAFT"], "fields[nominations]": ["name"] } });
  assert.equal(new URL(calls[0], "https://example.test").searchParams.get("filter[relatedApps]"), "123");
  assert.equal(result.data[0].attributes.name, "Launch");
  assert.equal(result.included, undefined);
  assert.equal(calls.length, 2);
  await assert.rejects(call(scope, op("getCollection"), { query: { "filter[state]": ["DRAFT"], "filter[relatedApps]": ["456"] } }), /selected app/);
  assert.equal(calls.length, 2);
});

test("app nominations can be created, updated and deleted", async () => {
  const writes = [];
  const call = createApiOperations({}, async (path, options) => {
    if (options?.method !== undefined && options.method !== "GET") writes.push(options.method);
    return options?.method === "DELETE" ? undefined : { data: nomination() };
  });
  await call(scope, op("createInstance"), { body: createBody(["123"]) });
  await call(scope, op("updateInstance"), { path: { id: "nom" }, body: { data: { type: "nominations", id: "nom", attributes: { name: "Updated" } } } });
  await call(scope, op("deleteInstance"), { path: { id: "nom" } });
  assert.deepEqual(writes, ["POST", "PATCH", "DELETE"]);
});

// Each case would leak or mutate a foreign/shared resource if ownership were
// inferred from only the first app or incomplete relationship linkage.
for (const [label, resource] of [
  ["foreign", nomination(["456"])], ["shared", nomination(["123", "456"])],
  ["empty", nomination([])], ["missing", { type: "nominations", id: "nom" }],
  ["wrong resource", { ...nomination(), id: "other" }],
  ["wrong parent type", { ...nomination(), relationships: { relatedApps: { data: [{ type: "actors", id: "123" }] } } }],
  ["truncated", { ...nomination(), relationships: { relatedApps: { ...nomination().relationships.relatedApps, meta: { paging: { total: 2, limit: 1 } } } } }],
  ["cursor", { ...nomination(), relationships: { relatedApps: { ...nomination().relationships.relatedApps, meta: { paging: { limit: 1, nextCursor: "next" } } } } }]
]) {
  test("app nominations reject " + label + " ownership before reads and mutations", async () => {
    const calls = [];
    const call = createApiOperations({}, async (path, options) => { calls.push({ path, options }); return { data: resource }; });
    for (const action of ["getInstance", "updateInstance", "deleteInstance"]) {
      await assert.rejects(call(scope, op(action), { path: { id: "nom" },
        ...(action === "updateInstance" ? { body: { data: { type: "nominations", id: "nom" } } } : {}) }), /ownership|different app|Unexpected/);
    }
    assert.equal(calls.length, 3);
    assert.ok(calls.every(c => !c.options?.method));
  });
}

test("nomination writes cannot create or replace ownership with empty or foreign apps", async () => {
  let writes = 0;
  const call = createApiOperations({}, async (path, options) => {
    if (options?.method && options.method !== "GET") writes++;
    return { data: nomination() };
  });
  for (const ids of [[], ["456"], ["123", "456"]]) {
    await assert.rejects(call(scope, op("createInstance"), { body: createBody(ids) }), /ownership|different app/);
    await assert.rejects(call(scope, op("updateInstance"), { path: { id: "nom" }, body: { data: { type: "nominations", id: "nom", relationships: nomination(ids).relationships } } }), /ownership|different app/);
  }
  assert.equal(writes, 0);
});

test("nomination mutations recheck ownership after a successful read", async () => {
  let foreign = false;
  let writes = 0;
  const call = createApiOperations({}, async (path, options) => {
    if (options?.method && options.method !== "GET") writes++;
    return { data: nomination(foreign ? ["123", "456"] : ["123"]) };
  });
  await call(scope, op("getInstance"), { path: { id: "nom" } });
  foreign = true;
  await assert.rejects(call(scope, op("deleteInstance"), { path: { id: "nom" } }), /different app/);
  assert.equal(writes, 0);
});

test("a filtered listing cannot return a shared nomination", async () => {
  const call = createApiOperations({}, async path => ({ data: path.startsWith("/v1/nominations?") ? [nomination(["123", "456"])] : nomination(["123", "456"]) }));
  await assert.rejects(call(scope, op("getCollection"), { query: { "filter[state]": ["DRAFT"] } }), /different app/);
});

test("a full relatedApps page without a total cannot prove nomination ownership", async () => {
  const call = createApiOperations({}, async () => ({ data: nomination(Array(50).fill("123")) }));
  await assert.rejects(call(scope, op("deleteInstance"), { path: { id: "nom" } }), /ownership/);
});

test("ownership respects a relatedApps page limit smaller than requested", async () => {
  const resource = nomination();
  resource.relationships.relatedApps.meta = { paging: { limit: 1 } };
  const call = createApiOperations({}, async () => ({ data: resource }));
  await assert.rejects(call(scope, op("deleteInstance"), { path: { id: "nom" } }), /ownership/);
});

test("nomination event references must belong to the selected app", async () => {
  let writes = 0;
  const call = createApiOperations({}, async (path, options) => {
    if (options?.method && options.method !== "GET") writes++;
    return { data: { type: "appEvents", id: "event", relationships: { app: { data: { type: "apps", id: "456" } } } } };
  });
  const body = createBody(["123"]);
  body.data.relationships.inAppEvents = { data: [{ type: "appEvents", id: "event" }] };
  await assert.rejects(call(scope, op("createInstance"), { body }), /different app/);
  assert.equal(writes, 0);
});

test("team nominations retain access to shared resources and unfiltered collections", async () => {
  const calls = [];
  const call = createApiOperations({}, async path => { calls.push(path); return { data: [nomination(["123", "456"])] }; });
  const result = await call({ type: "team" }, op("getCollection"), { query: { "filter[state]": ["DRAFT"] } });
  assert.equal(result.data.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0], "https://example.test").searchParams.has("filter[relatedApps]"), false);
});
