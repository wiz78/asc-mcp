import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import catalog from "./asc-resource-catalog.json" with { type: "json" };

// A deterministic Apple-shaped service for contract tests. It has no access
// to production credentials or the real network.
export function createFixture() {
  const records = new Map();
  const transfers = new Map();
  const requests = [];
  let uploads = 0;
  let leaderboardError;
  const put = resource => { records.set(resource.type + "/" + resource.id, resource); return resource; };
  const rel = (type, id) => ({ data: { type, id } });
  const make = (type, id, attributes = {}, relationships = {}) => put({ type, id, attributes, relationships });
  make("apps", "123", { name: "Fixture", bundleId: "test.fixture", primaryLocale: "en-US" });
  make("gameCenterDetails", "detail", { challengeEnabled: true }, { app: rel("apps", "123"), gameCenterGroup: { data: null } });
  make("appInfos", "info", { state: "PREPARE_FOR_SUBMISSION" }, { app: rel("apps", "123") });
  make("appStoreVersions", "version", { platform: "IOS", versionString: "1.0", appVersionState: "PREPARE_FOR_SUBMISSION" }, { app: rel("apps", "123") });
  make("appStoreVersionLocalizations", "english", { locale: "en-US", description: "Fixture" }, { appStoreVersion: rel("appStoreVersions", "version") });

  const knownType = type => Object.values(catalog).find(item => item.type === type);
  function response(data) { return Response.json({ data }); }
  function find(type, id) { return records.get(type + "/" + id); }
  function validateFields(attributes = {}, spec) {
    assert.ok(spec, "unexpected write operation");
    for (const name of spec.required) assert.ok(Object.hasOwn(attributes, name), "required field " + name);
    for (const name of Object.keys(attributes)) assert.ok(Object.hasOwn(spec.fields, name), "unknown field " + name);
  }
  return {
    records, requests,
    rejectNextLeaderboardCreate(error) { leaderboardError = error; },
    get uploads() { return uploads; },
    async fetch(url, init) {
      assert.equal(new URL(url).origin, "https://api.appstoreconnect.apple.com");
      assert.match(init.headers.Authorization, /^Bearer eyJ/);
      assert.equal(init.redirect, "error");
      const pathname = new URL(url).pathname;
      const [, version, type, id, relationship] = pathname.split("/");
      const method = init.method;
      requests.push({ pathname, method });
      if (type === "apps" && id === "123" && relationship === "gameCenterDetail") return response(find("gameCenterDetails", "detail"));
      if (method === "GET") {
        if (!id) throw new Error("Unscoped collection");
        const resource = find(type, id);
        if (!resource) return new Response(null, { status: 404 });
        if (!relationship) return response(resource);
        if (relationship === "image" || relationship === "defaultImage") {
          const imageType = type.replace(/(?:Localizations|Versions)$/, "Images");
          const relation = relationship === "defaultImage" ? "version" : "localization";
          const image = [...records.values()].find(item => item.type === imageType && item.relationships?.[relation]?.data?.id === id);
          return image ? response(image) : response(null);
        }
        if (type === "apps" && relationship === "appStoreVersions") {
          return response([...records.values()].filter(item => item.type === "appStoreVersions" && item.relationships?.app?.data?.id === id));
        }
        const child = Object.values(catalog).find(item =>
          item.collection === relationship && (item.root ? type === "gameCenterDetails" :
            item.parent === "app" ? type === "apps" :
            item.parent === "version" ? type === "appStoreVersions" : catalog[item.parent]?.type === type));
        if (child) return response([...records.values()].filter(item =>
          item.type === child.type && item.relationships?.[child.relation]?.data?.id === id));
        if (["placements", "appScreenshotSets", "appPreviewSets"].includes(relationship)) return response([]);
        throw new Error("Unexpected fixture relationship " + pathname);
      }
      const definition = knownType(type);
      assert.equal(version, definition.api);
      const body = init.body && JSON.parse(init.body);
      if (method === "POST") {
        if (type === "gameCenterLeaderboards" && leaderboardError) {
          const error = leaderboardError;
          leaderboardError = null;
          return Response.json({ errors: [error] }, { status: 409 });
        }
        assert.equal(body.data.type, type);
        if (!type.endsWith("Images")) validateFields(body.data.attributes, definition.create);
        for (const relationship of Object.values(body.data.relationships)) {
          if (Array.isArray(relationship.data)) continue;
          assert.ok(find(relationship.data.type, relationship.data.id), "unknown write parent");
        }
        const newId = randomUUID();
        const item = make(type, newId, body.data.attributes, body.data.relationships);
        if (body.included) {
          assert.ok(["gameCenterAchievements", "gameCenterLeaderboards"].includes(type));
          const versionType = type.replace(/s$/, "Versions");
          assert.equal(body.included[0].type, versionType);
          const temporary = body.included[0].id;
          assert.equal(body.data.relationships.versions.data[0].id, temporary);
          const parent = type === "gameCenterAchievements" ? "achievement" : "leaderboard";
          const versionResource = make(versionType, randomUUID(), { version: 1, state: "PREPARE_FOR_SUBMISSION" }, { [parent]: rel(type, newId) });
          item.relationships.versions = { data: [{ type: versionType, id: versionResource.id }] };
        }
        if (type.endsWith("Images")) {
          const url = "https://store-001.blobstore.apple.com/" + newId;
          item.attributes = {
            ...item.attributes,
            assetDeliveryState: { state: "AWAITING_UPLOAD" },
            uploadOperations: [{ method: "PUT", url, offset: 0, length: item.attributes.fileSize, requestHeaders: [{ name: "Content-Type", value: "image/png" }] }]
          };
          transfers.set(url, item);
        }
        return new Response(JSON.stringify({ data: item }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      const item = find(type, id);
      if (!item) return new Response(null, { status: 404 });
      if (method === "DELETE") {
        records.delete(type + "/" + id);
        return new Response(null, { status: 204 });
      }
      assert.equal(method, "PATCH");
      assert.equal(body.data.id, id);
      assert.equal(body.data.type, type);
      if (type.endsWith("Images")) {
        assert.deepEqual(body.data.attributes, { uploaded: true });
        assert.ok(item.bytesUploaded);
        item.attributes.assetDeliveryState.state = "COMPLETE";
      } else {
        validateFields(body.data.attributes, definition.update);
        Object.assign(item.attributes, body.data.attributes);
        Object.assign(item.relationships, body.data.relationships);
      }
      return response(item);
    },
    async uploadFetch(url, init) {
      const item = transfers.get(url);
      assert.ok(item, "unknown upload destination");
      assert.equal(init.method, "PUT");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.headers.authorization, undefined);
      assert.equal(init.body.length, item.attributes.fileSize);
      item.bytesUploaded = true;
      uploads++;
      return new Response(null, { status: 200 });
    }
  };
}
