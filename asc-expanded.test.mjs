import assert from "node:assert/strict";
import { test } from "node:test";
import { createExpandedOperations } from "./asc-expanded.mjs";

const resource = (type, id, parent, parentType, parentId, attributes = {}) => ({
  type, id, attributes, relationships: parent ? {
    [parent]: { data: { type: parentType, id: parentId } }
  } : {}
});

test("Game Center parent traversal, cache reuse, and foreign IDs", async () => {
  const calls = [];
  const records = {
    gameCenterAchievements: resource("gameCenterAchievements", "a1", "gameCenterDetail", "gameCenterDetails", "detail", { referenceName: "First" }),
    gameCenterDetails: resource("gameCenterDetails", "detail", "app", "apps", "123"),
    gameCenterAchievementVersions: resource("gameCenterAchievementVersions", "v1", "achievement", "gameCenterAchievements", "a1"),
    gameCenterAchievementLocalizations: resource("gameCenterAchievementLocalizations", "l1", "version", "gameCenterAchievementVersions", "v1", { locale: "en-US", name: "First" })
  };
  const call = createExpandedOperations({ cue: "123" }, async (path, options) => {
    calls.push([path, options?.method || "GET"]);
    if (options?.method === "PATCH") return { data: records.gameCenterAchievementLocalizations };
    const type = path.split("/")[2];
    if (path.includes("/foreign")) return { data: resource(type, "foreign", "app", "apps", "456") };
    return { data: records[type] };
  });
  assert.equal((await call("cue", "get_gc_achievement_localization", { id: "l1" })).locale, "en-US");
  const count = calls.length;
  await call("cue", "get_gc_achievement_localization", { id: "l1" });
  assert.equal(calls.length, count, "typed resources should be cached");
  await assert.rejects(call("cue", "get_app_info", { id: "foreign" }), /ownership/);
  await assert.rejects(call("other", "get_gc_achievement", { id: "a1" }), /Unknown app/);
  await assert.rejects(call("cue", "update_gc_achievement", { id: "a1", attributes: { vendorIdentifier: "changed" } }), /Invalid/);
});

test("shared Game Center group mutation requires every member app allowed", async () => {
  let mutations = 0;
  const call = createExpandedOperations({ cue: "123" }, async (path, options) => {
    if (options?.method) mutations++;
    if (path.startsWith("/v2/gameCenterAchievements/")) return { data: {
      ...resource("gameCenterAchievements", "shared"),
      relationships: { gameCenterGroup: { data: { type: "gameCenterGroups", id: "g1" } } }
    } };
    if (path.includes("/gameCenterDetails")) return { data: [
      resource("gameCenterDetails", "d1", "app", "apps", "123"),
      resource("gameCenterDetails", "d2", "app", "apps", "456")
    ] };
    throw new Error("Unexpected request");
  });
  await assert.rejects(call("cue", "update_gc_achievement", { id: "shared", attributes: { referenceName: "Changed" } }), /shared|ownership/i);
  assert.equal(mutations, 0);
});

test("mutable Game Center group membership is rechecked before a cached root write", async () => {
  let grouped = false;
  let writes = 0;
  const call = createExpandedOperations({ cue: "123" }, async (path, options) => {
    if (options?.method) { writes++; throw new Error("Must not write"); }
    if (path.includes("/gameCenterAchievements/")) return { data: {
      ...resource("gameCenterAchievements", "a1", "gameCenterDetail", "gameCenterDetails", "detail"),
      relationships: {
        gameCenterDetail: { data: { type: "gameCenterDetails", id: "detail" } },
        gameCenterGroup: { data: grouped ? { type: "gameCenterGroups", id: "g1" } : null }
      }
    } };
    if (path.includes("/gameCenterGroups/")) return { data: [
      resource("gameCenterDetails", "detail", "app", "apps", "123"),
      resource("gameCenterDetails", "foreign", "app", "apps", "456")
    ] };
    return { data: resource("gameCenterDetails", "detail", "app", "apps", "123") };
  });
  await call("cue", "get_gc_achievement", { id: "a1" });
  grouped = true;
  await assert.rejects(call("cue", "update_gc_achievement", { id: "a1", attributes: { archived: true } }), /Shared/);
  assert.equal(writes, 0);
});

test("nested localization references and challenge leaderboard references cannot cross apps", async () => {
  let writes = 0;
  const call = createExpandedOperations({ cue: "123" }, async (path, options) => {
    if (options?.method) { writes++; throw new Error("Must not write"); }
    if (path.includes("/apps/123/")) return { data: resource("gameCenterDetails", "detail", "app", "apps", "123") };
    if (path.includes("/gameCenterLeaderboards/")) return { data: resource("gameCenterLeaderboards", "board", "gameCenterDetail", "gameCenterDetails", "foreign") };
    if (path.includes("/gameCenterAchievementLocalizations/")) return { data: resource("gameCenterAchievementLocalizations", "loc", "version", "gameCenterAchievementVersions", "version") };
    if (path.includes("/gameCenterAchievementVersions/")) return { data: resource("gameCenterAchievementVersions", "version", "achievement", "gameCenterAchievements", "achievement") };
    if (path.includes("/gameCenterAchievements/")) return { data: resource("gameCenterAchievements", "achievement", "gameCenterDetail", "gameCenterDetails", "foreign") };
    return { data: resource("gameCenterDetails", "foreign", "app", "apps", "456") };
  });
  await assert.rejects(call("cue", "delete_gc_achievement_localization", { id: "loc" }), /ownership/);
  await assert.rejects(call("cue", "create_gc_challenge", { attributes: { referenceName: "Challenge", vendorIdentifier: "test.challenge" }, leaderboard_id: "board" }), /ownership/);
  assert.equal(writes, 0);
});

test("collection pagination cannot change the resource parent or include constraints", async () => {
  let requests = 0;
  const call = createExpandedOperations({ cue: "123" }, async path => {
    requests++;
    if (path.startsWith("/v1/apps/123/appInfos")) return {
      data: [],
      links: { next: "https://api.appstoreconnect.apple.com/v1/apps/456/appInfos?limit=200" }
    };
    throw new Error("Foreign page must never be requested");
  });
  await assert.rejects(call("cue", "list_app_infos", {}), /pagination/);
  assert.equal(requests, 1);
});
