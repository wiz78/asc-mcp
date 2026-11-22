import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createUploads, validateUploadOperations } from "./asc-uploads.mjs";

const operation = { method: "PUT", url: "https://store-001.blobstore.apple.com/image?signature=private", offset: 0, length: 24, requestHeaders: [] };
test("upload destinations and ranges reject redirects, credentials, private hosts and overlaps", () => {
  assert.doesNotThrow(() => validateUploadOperations([operation], 24));
  for (const url of ["http://store-001.blobstore.apple.com/a", "https://127.0.0.1/a", "https://apple.com.evil.test/a", "https://user@store-001.blobstore.apple.com/a", "https://store-001.blobstore.apple.com:8443/a"]) {
    assert.throws(() => validateUploadOperations([{ ...operation, url }], 24), /upload/i);
  }
  assert.throws(() => validateUploadOperations([{ ...operation, requestHeaders: [{ name: "Authorization", value: "secret" }] }], 24), /upload/i);
  assert.throws(() => validateUploadOperations([{ ...operation, length: 12 }, { ...operation, length: 12 }], 24), /upload/i);
});

test("upload session binds app, resource, checksum, retries and commit", async () => {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(1024, 16);
  bytes.writeUInt32BE(1024, 20);
  let committed = false;
  let sends = 0;
  const uploads = createUploads(async (url, init) => {
    sends++;
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "error");
    assert.deepEqual(Buffer.from(init.body), bytes);
    return new Response(null, { status: 200 });
  });
  const context = {
    verify: async () => ({ type: "gameCenterAchievementLocalizations", id: "loc" }),
    invalidate() {},
    request: async (path, options) => {
      if (options?.method === "POST") return { data: { id: "image", type: "gameCenterAchievementImages", attributes: { uploadOperations: [operation] } } };
      if (options?.method === "PATCH") { committed = true; return; }
      return { data: { id: "image", type: "gameCenterAchievementImages", attributes: { assetDeliveryState: { state: committed ? "COMPLETE" : "AWAITING_UPLOAD" } } } };
    }
  };
  const args = { target: "achievement_localization", parent_id: "loc", file_name: "image.png", file_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const start = await uploads.call("cue", "123", "_image_begin", args, context);
  assert.deepEqual(await uploads.call("cue", "123", "_image_begin", args, context), start);
  await assert.rejects(uploads.call("other", "456", "_image_chunk", { upload_id: start.upload_id, offset: 0, base64: bytes.toString("base64") }, context), /session/);
  const chunk = { upload_id: start.upload_id, offset: 0, base64: bytes.toString("base64") };
  await uploads.call("cue", "123", "_image_chunk", chunk, context);
  await uploads.call("cue", "123", "_image_chunk", chunk, context);
  const result = await uploads.call("cue", "123", "_image_commit", { upload_id: start.upload_id }, context);
  assert.equal(result.assetDeliveryState.state, "COMPLETE");
  await uploads.call("cue", "123", "_image_commit", { upload_id: start.upload_id }, context);
  assert.equal(sends, 1);
  uploads.close();
});

test("invalid ownership and malicious reservation instructions cannot transfer data", async () => {
  let reserves = 0;
  let transfers = 0;
  const uploads = createUploads(async () => { transfers++; throw new Error("No transfer allowed"); });
  const input = { target: "achievement_localization", parent_id: "foreign", file_name: "image.png", file_size: 24, sha256: "0".repeat(64) };
  const context = {
    verify: async () => { throw new Error("Foreign ownership"); },
    request: async () => { reserves++; },
    invalidate() {}
  };
  try {
    await assert.rejects(uploads.call("cue", "123", "_image_begin", input, context), /ownership/);
    assert.equal(reserves, 0);
    context.verify = async () => ({ type: "gameCenterAchievementLocalizations", id: "foreign" });
    let deleted = false;
    context.request = async (path, options) => {
      if (options.method === "DELETE") { deleted = true; return; }
      reserves++;
      return { data: { id: "image", type: "gameCenterAchievementImages", attributes: {
        uploadOperations: [{ ...operation, url: "https://localhost/credential-exfiltration" }]
      } } };
    };
    await assert.rejects(uploads.call("cue", "123", "_image_begin", input, context), /upload/i);
    assert.equal(deleted, true);
    assert.equal(transfers, 0);
  } finally { uploads.close(); }
});

test("commit retry recovers a lost response and upload expiry releases the session", async () => {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(1024, 16);
  bytes.writeUInt32BE(1024, 20);
  let now = 0;
  let sends = 0;
  let committed = false;
  const uploads = createUploads(async () => { sends++; return new Response(null, { status: 200 }); }, { now: () => now });
  const context = {
    verify: async () => ({ type: "gameCenterLeaderboardLocalizations", id: "loc" }),
    invalidate() {},
    request: async (path, options) => {
      if (options?.method === "POST") return { data: { id: "image", type: "gameCenterLeaderboardImages", attributes: { uploadOperations: [operation] } } };
      if (options?.method === "PATCH") { committed = true; throw new Error("Lost commit response"); }
      return { data: { id: "image", type: "gameCenterLeaderboardImages", attributes: { assetDeliveryState: { state: committed ? "COMPLETE" : "AWAITING_UPLOAD" } } } };
    }
  };
  try {
    const session = await uploads.call("cue", "123", "_image_begin", { target: "leaderboard_localization", parent_id: "loc", file_name: "image.png", file_size: 24, sha256: createHash("sha256").update(bytes).digest("hex") }, context);
    await uploads.call("cue", "123", "_image_chunk", { upload_id: session.upload_id, offset: 0, base64: bytes.toString("base64") }, context);
    await assert.rejects(uploads.call("cue", "123", "_image_commit", { upload_id: session.upload_id }, context), /Lost commit/);
    assert.equal((await uploads.call("cue", "123", "_image_commit", { upload_id: session.upload_id }, context)).assetDeliveryState.state, "COMPLETE");
    assert.equal(sends, 1);
    now = 600_001;
    await assert.rejects(uploads.call("cue", "123", "_image_commit", { upload_id: session.upload_id }, context), /expired/);
  } finally { uploads.close(); }
});
