import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "./asc-runtime.mjs";
import { createUploads } from "./asc-uploads.mjs";
import { createApiOperations } from "./asc-api.mjs";
import { apiOperations } from "./asc-catalog.mjs";

function config(deny = [], allow = ["*"]) {
  return { apps: { fixture: { id: "123", policy: "policy" } }, policies: { policy: { allow, deny } } };
}

test("generic update body cannot bypass a denied relationship domain", async () => {
  const uploads = createUploads();
  let calls = 0;
  try {
    const runtime = createRuntime(config(["write:builds"]), async () => { calls++; }, uploads);
    await assert.rejects(runtime.call("fixture", "api_appStoreVersions_updateInstance", {
      path: { id: "version" }, body: { data: {
        type: "appStoreVersions", id: "version",
        relationships: { build: { data: { type: "builds", id: "build" } } }
      } }
    }), /resource domain.*policy/);
    assert.equal(calls, 0);
  } finally { uploads.close(); }
});

test("all legacy image aliases and media aggregates respect their underlying domains", async () => {
  const uploads = createUploads();
  let calls = 0;
  try {
    const runtime = createRuntime(config(["game-center achievements images", "screenshots", "video-previews"]), async () => { calls++; }, uploads);
    for (const [name, input] of [
      ["get_gc_achievement_image", { id: "image" }],
      ["get_gc_achievement_localization_image", { localization_id: "locale" }],
      ["list_version_media", { localization_id: "locale" }]
    ]) {
      await assert.rejects(runtime.call("fixture", name, input), /policy/);
      assert.equal(runtime.definitions("fixture").some(tool => tool.name === name), false);
    }
    assert.equal(calls, 0);
  } finally { uploads.close(); }
});

test("image target family is enforced at begin and against saved session state", async () => {
  const uploads = createUploads();
  let calls = 0;
  try {
    const runtime = createRuntime(config(["write:game-center achievements images"]), async () => { calls++; }, uploads);
    await assert.rejects(runtime.call("fixture", "_image_begin", {
      target: "achievement_localization", parent_id: "locale",
      file_name: "image.png", file_size: 24, sha256: "0".repeat(64)
    }), /policy/);
    const session = await uploads.call("fixture", "123", "_image_begin", {
      target: "achievement_localization", parent_id: "locale",
      file_name: "image.png", file_size: 24, sha256: "0".repeat(64)
    }, {
      verify: async () => ({ type: "gameCenterAchievementLocalizations", id: "locale" }),
      request: async () => ({ data: { type: "gameCenterAchievementImages", id: "image", attributes: {
        uploadOperations: [{
          method: "PUT", url: "https://store-001.blobstore.apple.com/image",
          offset: 0, length: 24, requestHeaders: []
        }]
      } } })
    });
    for (const operation of ["_image_chunk", "_image_commit", "_image_cancel"]) {
      await assert.rejects(runtime.call("fixture", operation, { upload_id: session.upload_id }), /policy/);
    }
    assert.equal(calls, 0);
  } finally { uploads.close(); }
});

test("collection includes resolve their target resource model", async () => {
  const uploads = createUploads();
  let calls = 0;
  try {
    const runtime = createRuntime(config([], ["read:*"]), async () => { calls++; return { data: [] }; }, uploads);
    assert.deepEqual(await runtime.call("fixture", "api_apps_getCollection", { query: { include: ["appInfos"] } }), { data: [] });
    assert.equal(calls, 1);
  } finally { uploads.close(); }
});

test("shared mutations require write permission on every affected app", async () => {
  const uploads = createUploads();
  let writes = 0;
  try {
    const runtime = createRuntime({
      apps: { first: { id: "123", policy: "write" }, second: { id: "456", policy: "read" } },
      policies: { write: { allow: ["game-center"] }, read: { allow: ["read:game-center"] } }
    }, async (path, options) => {
      if (options?.method && options.method !== "GET") writes++;
      if (path.includes("/gameCenterGroups/")) return { data: ["123", "456"].map(id => ({
        type: "gameCenterDetails", id: "detail-" + id,
        relationships: { app: { data: { type: "apps", id } } }
      })) };
      return { data: { type: "gameCenterAchievements", id: "achievement",
        relationships: { gameCenterGroup: { data: { type: "gameCenterGroups", id: "group" } } }
      } };
    }, uploads);
    await assert.rejects(runtime.call("first", "update_gc_achievement", { id: "achievement", attributes: { archived: true } }), /affected app policy/);
    assert.equal(writes, 0);
  } finally { uploads.close(); }
});

test("relationship linkages cannot grant ownership to their own unresolved inline IDs", async () => {
  let writes = 0;
  const call = createApiOperations({ fixture: "123" }, async (path, options) => {
    if (options?.method && options.method !== "GET") writes++;
    return { data: { type: "betaGroups", id: "group", relationships: { app: { data: { type: "apps", id: "123" } } } } };
  });
  await assert.rejects(call({ type: "app", id: "123" }, apiOperations.get("api_betaGroups_builds_createToManyRelationship"), {
    path: { id: "group" }, body: { data: [{ type: "builds", id: "${unresolved}" }] }
  }), /ownership/);
  assert.equal(writes, 0);
});

test("general image denies remain effective and explain matches target permissions", async () => {
  const { operationInventory } = await import("./asc-runtime.mjs");
  const uploads = createUploads();
  try {
    const input = config(["write:game-center images"]);
    const runtime = createRuntime(input, async () => { throw new Error("No request allowed"); }, uploads);
    await assert.rejects(runtime.call("fixture", "_image_begin", { target: "achievement_localization" }), /policy/);
    assert.equal(operationInventory(input, "fixture").find(tool => tool.name === "upload_game_center_image").allowed, false);
    const targeted = config([], ["write:game-center achievements images"]);
    assert.equal(operationInventory(targeted, "fixture").find(tool => tool.name === "upload_game_center_image").allowed, true);
  } finally { uploads.close(); }
});

test("concurrent mutations cannot reuse another operation's shared-group authorization", async () => {
  const uploads = createUploads();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const mutations = [];
  try {
    const runtime = createRuntime({
      apps: { first: { id: "123", policy: "editor" }, second: { id: "456", policy: "limited" } },
      policies: {
        editor: { allow: ["game-center"] },
        limited: { allow: ["update_gc_achievement"], deny: ["delete_gc_achievement"] }
      }
    }, async (path, options) => {
      if (options?.method) {
        mutations.push(options.method);
        return { data: { type: "gameCenterAchievements", id: "achievement", attributes: { referenceName: "Updated" } } };
      }
      if (path.includes("/gameCenterGroups/")) return { data: ["123", "456"].map(id => ({
        type: "gameCenterDetails", id: "detail-" + id, relationships: { app: { data: { type: "apps", id } } }
      })) };
      started();
      await gate;
      return { data: { type: "gameCenterAchievements", id: "achievement",
        relationships: { gameCenterGroup: { data: { type: "gameCenterGroups", id: "group" } } }
      } };
    }, uploads);
    const update = runtime.call("first", "update_gc_achievement", { id: "achievement", attributes: { referenceName: "Updated" } });
    await firstStarted;
    const deletion = runtime.call("first", "delete_gc_achievement", { id: "achievement" });
    const result = Promise.allSettled([update, deletion]);
    release();
    const [updated, deleted] = await result;
    assert.equal(updated.status, "fulfilled");
    assert.equal(deleted.status, "rejected");
    assert.match(deleted.reason.message, /affected app policy/);
    assert.deepEqual(mutations, ["PATCH"]);
  } finally { release(); uploads.close(); }
});
