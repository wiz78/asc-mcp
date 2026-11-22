import { createPrivateKey, sign } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createUploads } from "./asc-uploads.mjs";
import { PublicError } from "./asc-errors.mjs";
import { createRuntime, validateConfiguration } from "./asc-runtime.mjs";

const appleOrigin = "https://api.appstoreconnect.apple.com";
const envelope = z.strictObject({
  app: z.string().max(64),
  operation: z.string().max(64),
  input: z.unknown()
});


class AppleApiError extends PublicError {
  constructor(status, appleErrors) {
    super(`App Store Connect returned HTTP ${status}.`);
    this.appleErrors = appleErrors;
  }
}

async function readBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new PublicError("Apple response exceeds the supported size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readErrorBody(response) {
  try { return JSON.parse((await readBody(response, 64 * 1024)).toString("utf8")); }
  catch { return; }
}

export function createAppleClient(env, fetchImpl = fetch) {
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_PRIVATE_KEY_B64: encodedKey } = env;
  const pem = env.ASC_PRIVATE_KEY || Buffer.from(encodedKey || "", "base64").toString("utf8");
  if (!/^[A-Z0-9]{10}$/.test(keyId || "") || !/^[\da-f-]{36}$/i.test(issuerId || "") || !pem) {
    throw new Error("Invalid Apple credentials");
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails.namedCurve !== "prime256v1") {
    throw new Error("Invalid Apple signing key");
  }
  const rawSensitive = [keyId, issuerId, encodedKey, pem, Buffer.from(pem).toString("base64"), env.OP_SERVICE_ACCOUNT_TOKEN,
    ...pem.split(/\r?\n/).filter(line => /^[A-Za-z0-9+/=]{16,}$/.test(line))]
    .filter(Boolean);
  const sensitive = [...new Set(rawSensitive.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  function sanitize(value, limit) {
    if (typeof value !== "string") return;
    let clean = value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]");
    for (const secret of sensitive) clean = clean.split(secret).join("[redacted]");
    return clean
      .replace(/Bearer\s+[^\s"'<>]+/gi, "[redacted]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, limit);
  }
  function projectErrors(body) {
    if (!Array.isArray(body?.errors)) return;
    const errors = [];
    for (const entry of body.errors.slice(0, 10)) {
      const error = {};
      for (const [field, limit] of [["code", 256], ["title", 512], ["detail", 2048]]) {
        const value = sanitize(entry?.[field], limit);
        if (value) error[field] = value;
      }
      const source = {};
      for (const [field, limit] of [["pointer", 512], ["parameter", 128]]) {
        const value = sanitize(entry?.source?.[field], limit);
        if (value) source[field] = value;
      }
      if (Object.keys(source).length) error.source = source;
      if (Object.keys(error).length) errors.push(error);
    }
    return errors.length ? errors : undefined;
  }
  let token;
  let expires = 0;
  function bearer() {
    const now = Math.floor(Date.now() / 1000);
    if (expires - now < 30) {
      expires = now + 300;
      const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
      const message = encode({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." +
        encode({ iss: issuerId, iat: now, exp: expires, aud: "appstoreconnect-v1" });
      token = message + "." + sign("sha256", Buffer.from(message), {
        key, dsaEncoding: "ieee-p1363"
      }).toString("base64url");
    }
    return token;
  }

  return {
    async request(path, { method = "GET", body } = {}) {
      const url = new URL(path, appleOrigin);
      if (url.origin !== appleOrigin) throw new Error("Unexpected Apple URL");
      const response = await fetchImpl(url, {
        method,
        headers: { Authorization: "Bearer " + bearer(), "Content-Type": "application/json" },
        body: body && JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        throw new AppleApiError(response.status, projectErrors(await readErrorBody(response)));
      }
      if (response.status === 204 || method === "DELETE") {
        await response.body?.cancel();
        return;
      }
      const bytes = await readBody(response, 16 * 1024 * 1024);
      const contentType = response.headers.get("content-type") || "application/json";
      if (/json/i.test(contentType)) return JSON.parse(bytes.toString("utf8"));
      return { contentType, encoding: "base64", data: bytes.toString("base64") };
    },
    mayReturn(json) {
      return !sensitive.some(value => json.includes(value)) &&
        !json.includes("PRIVATE KEY-----") &&
        !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(json);
    }
  };
}

export function createDaemon(apps, apple, { uploadDirectory } = {}) {
  const uploads = createUploads(apple.uploadFetch, { mediaDirectory: uploadDirectory });
  const input = apps.apps && typeof apps.apps === "object" ? apps : { apps };
  const runtime = createRuntime(input, apple.request, uploads);
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 }, async (req, res) => {
    const send = (status, value) => {
      let body = JSON.stringify(value);
      if (!apple.mayReturn(body)) {
        status = 502;
        body = '{"error":"Response withheld because it contains credential material."}';
      }
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
    };
    if (req.method !== "POST" || req.url !== "/call") {
      send(404, { error: "Unknown daemon endpoint." });
      return;
    }
    let data;
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1024 * 1024) {
          send(413, { error: "Request too large." });
          return;
        }
        chunks.push(chunk);
      }
      data = envelope.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      send(400, { error: "Invalid daemon request." });
      return;
    }
    try {
      send(200, { result: await runtime.call(data.app, data.operation, data.input) });
    } catch (error) {
      const response = { error: error instanceof PublicError ? error.message : "App Store Connect request failed." };
      if (error instanceof AppleApiError && error.appleErrors) response.appleErrors = error.appleErrors;
      send(400, response);
    }
  });
  server.on("close", () => uploads.close());
  return server;
}

async function main() {
  process.umask(0o077);
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  const { config } = validateConfiguration(input);
  const apple = createAppleClient(process.env);
  for (const key of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY", "ASC_PRIVATE_KEY_B64", "OP_SERVICE_ACCOUNT_TOKEN"]) {
    delete process.env[key];
  }
  const server = createDaemon(input, apple, { uploadDirectory: resolve(dirname(process.argv[2]), "../state") });
  let idleTimer;
  let connections = 0;
  function scheduleIdleExit() {
    idleTimer = setTimeout(() => server.close(), config.idleTimeoutMs);
  }
  server.on("connection", socket => {
    connections++;
    clearTimeout(idleTimer);
    socket.once("close", () => {
      connections--;
      if (connections === 0) scheduleIdleExit();
    });
  });
  server.on("error", () => {
    console.error("ASC daemon listener failed.");
    process.exit(1);
  });
  server.listen({ fd: 0 }, scheduleIdleExit);
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1])).href === import.meta.url) {
  await main().catch(() => {
    console.error("ASC daemon setup failed. Check the service configuration and credential injection.");
    process.exit(1);
  });
}
