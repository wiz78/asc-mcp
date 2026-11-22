import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { bridgeUpload } from "./asc-bridge-upload.mjs";
import { test } from "node:test";
import { createAppleClient } from "./asc-daemon.mjs";

function client(body) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const env = {
    ASC_KEY_ID: "SYNTHETIC1",
    ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000001",
    ASC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    OP_SERVICE_ACCOUNT_TOKEN: "synthetic-op-service-token"
  };
  return createAppleClient(env, async (url, init) => new Response(
    typeof body === "function" ? body(env, init.headers.Authorization) : body,
    { status: 409 }
  ));
}

test("Apple error projection preserves code/detail/source and drops arbitrary fields", async () => {
  const apple = client(JSON.stringify({ errors: [{
    status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
    title: "Invalid attribute", detail: "The vendorIdentifier is invalid.",
    source: { pointer: "/data/attributes/vendorIdentifier", unknown: "ignored" },
    links: { about: "https://example.test/private" }, debug: "ignored"
  }] }));
  await assert.rejects(apple.request("/v2/gameCenterLeaderboards"), error => {
    assert.equal(error.message, "App Store Connect returned HTTP 409.");
    assert.deepEqual(error.appleErrors, [{
      code: "ENTITY_ERROR.ATTRIBUTE.INVALID", title: "Invalid attribute",
      detail: "The vendorIdentifier is invalid.",
      source: { pointer: "/data/attributes/vendorIdentifier" }
    }]);
    return true;
  });
});

test("Apple error fields redact credentials, JWTs, PEM and signed URLs before truncating", async () => {
  const apple = client((env, bearer) => JSON.stringify({ errors: [{
    code: "INVALID",
    title: env.ASC_KEY_ID,
    detail: [env.ASC_ISSUER_ID, env.OP_SERVICE_ACCOUNT_TOKEN, bearer,
      env.ASC_PRIVATE_KEY, "https://store-001.blobstore.apple.com/a?signature=secret"].join(" "),
    source: { parameter: env.OP_SERVICE_ACCOUNT_TOKEN }
  }] }));
  await assert.rejects(apple.request("/v2/gameCenterLeaderboards"), error => {
    const json = JSON.stringify(error.appleErrors);
    assert.ok(error.appleErrors, "sanitized diagnostic fields should be present");
    assert.match(json, /redacted/);
    assert.ok(apple.mayReturn(json));
    for (const secret of ["SYNTHETIC1", "00000000-", "synthetic-op-service-token", "PRIVATE KEY", "signature=secret", "eyJ"]) {
      assert.equal(json.includes(secret), false, secret);
    }
    return true;
  });
});

test("malformed, oversized and non-error bodies fall back to status only", async () => {
  for (const body of ["not JSON", "x".repeat(65537), '{"errors":"private"}', '{"debug":"private"}']) {
    await assert.rejects(client(body).request("/v2/gameCenterLeaderboards"), error => {
      assert.equal(error.message, "App Store Connect returned HTTP 409.");
      assert.equal(error.appleErrors, undefined);
      return true;
    });
  }
});

test("image commit errors retain sanitized Apple diagnostics alongside the resume ID", async () => {
  const directory = await mkdtemp("/private/tmp/asc-error-");
  try {
    const path = join(directory, "image.png");
    await writeFile(path, Buffer.alloc(24));
    const appleErrors = [{ code: "ENTITY_ERROR", detail: "The image is invalid." }];
    const response = await bridgeUpload(async operation => {
      if (operation === "_image_begin") return { result: { upload_id: "session", asset_id: "asset", received: 0 } };
      if (operation === "_image_chunk") return { result: { received: 24 } };
      return { error: "App Store Connect returned HTTP 409.", appleErrors };
    }, "upload_game_center_image", { target: "achievement_localization", parent_id: "loc", file_path: path });
    assert.deepEqual(response.appleErrors, appleErrors);
    assert.match(response.error, /Resume or cancel upload session/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("non-JSON API downloads are returned as bounded binary data", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const apple = createAppleClient({
    ASC_KEY_ID: "SYNTHETIC1", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000001",
    ASC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" })
  }, async () => new Response(Buffer.from([0x1f, 0x8b, 0, 1]), { headers: { "Content-Type": "application/a-gzip" } }));
  const result = await apple.request("/v1/salesReports");
  assert.equal(result.contentType, "application/a-gzip");
  assert.equal(result.encoding, "base64");
  assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from([0x1f, 0x8b, 0, 1]));
});
