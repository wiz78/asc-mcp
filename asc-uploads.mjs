import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createMediaUploads } from "./asc-media-uploads.mjs";
import { PublicError } from "./asc-errors.mjs";
import catalog from "./asc-resource-catalog.json" with { type: "json" };

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const targets = {
  achievement_localization: ["gc_achievement_localization", "gc_achievement_image", "localization"],
  leaderboard_localization: ["gc_leaderboard_localization", "gc_leaderboard_image", "localization"],
  challenge_localization: ["gc_challenge_localization", "gc_challenge_image", "localization"],
  challenge_version: ["gc_challenge_version", "gc_challenge_image", "version"]
};
export const imageTarget = z.enum(Object.keys(targets));
export const maxImageBytes = 20 * 1024 * 1024;
const beginSchema = z.strictObject({
  target: imageTarget, parent_id: id,
  file_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,180}\.(?:png|jpg|jpeg)$/i),
  file_size: z.number().int().min(24).max(maxImageBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const sessionSchema = z.strictObject({ upload_id: z.string().uuid() });
const chunkSchema = sessionSchema.extend({
  offset: z.number().int().min(0).max(maxImageBytes),
  base64: z.string().min(4).max(44_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
});
const schemas = {
  _image_begin: beginSchema,
  _image_chunk: chunkSchema,
  _image_commit: sessionSchema,
  _image_cancel: sessionSchema
};

export function validateUploadOperations(operations, length) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new PublicError("Invalid Apple upload instructions.");
  let offset = 0;
  for (const operation of [...operations].sort((a, b) => a.offset - b.offset)) {
    let url;
    try { url = new URL(operation.url); } catch { throw new PublicError("Invalid Apple upload URL."); }
    if (url.protocol !== "https:" || (!/^[a-z0-9-]+\.blobstore\.apple\.com$/.test(url.hostname) &&
        url.hostname !== "northamerica-1.object-storage.apple.com") ||
        url.port || url.username || url.password || url.hash || operation.method !== "PUT") {
      const method = ["PUT", "POST", "GET", "PATCH", "DELETE"].includes(operation.method) ? operation.method : "unsupported";
      throw new PublicError("Invalid Apple upload URL or method (host: " + url.hostname + ", method: " + method + ").");
    }
    if (!Number.isSafeInteger(operation.length) || operation.length < 1 || operation.offset !== offset) {
      throw new PublicError("Invalid Apple upload byte ranges.");
    }
    offset += operation.length;
    if (!Array.isArray(operation.requestHeaders) || operation.requestHeaders.length > 30) throw new PublicError("Invalid Apple upload headers.");
    for (const header of operation.requestHeaders) {
      if (typeof header.name !== "string" || typeof header.value !== "string" ||
          !/^[A-Za-z0-9-]+$/.test(header.name) || /[\r\n]/.test(header.value) ||
          !/^(?:content-type|content-length|content-md5|x-apple-[a-z0-9-]+|x-amz-[a-z0-9-]+)$/i.test(header.name)) {
        throw new PublicError("Invalid Apple upload headers.");
      }
    }
  }
  if (offset !== length) throw new PublicError("Invalid Apple upload total length.");
}

function validateImage(bytes, target) {
  const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  let width;
  let height;
  if (png && bytes.subarray(12, 16).toString() === "IHDR") {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    if (target.startsWith("challenge") && bytes.length > 25 && [4, 6].includes(bytes[25])) {
      throw new PublicError("Challenge images must have no transparency.");
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  }
  const challenge = target.startsWith("challenge");
  if (width !== (challenge ? 3840 : 1024) || height !== (challenge ? 2160 : 1024)) {
    throw new PublicError(challenge ? "Use a 3840x2160 PNG or JPEG challenge image." : "Use a 1024x1024 PNG or JPEG Game Center image.");
  }
}

export function createUploads(fetchImpl = fetch, { now = Date.now, mediaDirectory } = {}) {
  const media = createMediaUploads(fetchImpl, validateUploadOperations, { now, root: mediaDirectory });
  const sessions = new Map();
  const starting = new Map();
  let reserved = 0;

  function remove(session) {
    if (session.bytes) reserved -= session.bytes.length;
    session.bytes = null;
    sessions.delete(session.id);
  }
  function expire() {
    for (const session of sessions.values()) {
      if (!session.busy && session.expires <= now()) remove(session);
    }
  }
  const timer = setInterval(expire, 30_000).unref();
  const path = session => "/" + session.definition.api + "/" + session.definition.type + "/" + session.assetId;
  const status = session => ({ upload_id: session.id, asset_id: session.assetId, received: session.received });

  async function begin(alias, app, input, context) {
    expire();
    const fingerprint = JSON.stringify([alias, app, input.target, input.parent_id, input.sha256, input.file_size]);
    for (const session of sessions.values()) {
      if (session.fingerprint === fingerprint) return status(session);
    }
    if (starting.has(fingerprint)) return starting.get(fingerprint);
    const job = (async () => {
      if (sessions.size + starting.size >= 8 || reserved + input.file_size > 64 * 1024 * 1024) {
        throw new PublicError("Image upload capacity reached. Finish or cancel an upload.");
      }
      reserved += input.file_size;
      const [parentKind, imageKind, relation] = targets[input.target];
      let assetId;
      const definition = catalog[imageKind];
      try {
        const parent = await context.verify(app, parentKind, input.parent_id, true);
        const result = await context.request("/" + definition.api + "/" + definition.type, {
          method: "POST",
          body: { data: {
            type: definition.type,
            attributes: { fileSize: input.file_size, fileName: input.file_name },
            relationships: { [relation]: { data: { type: parent.type, id: parent.id } } }
          } }
        });
        const resource = result?.data;
        if (resource?.type !== definition.type || !id.safeParse(resource.id).success) throw new PublicError("Invalid Apple image reservation.");
        assetId = resource.id;
        validateUploadOperations(resource.attributes?.uploadOperations, input.file_size);
        const session = {
          id: randomUUID(), alias, app, input, definition, assetId, parentKind, imageKind,
          operations: resource.attributes.uploadOperations, fingerprint,
          expires: now() + 600_000, received: 0, bytes: Buffer.alloc(input.file_size),
          busy: false, sent: false, committed: false
        };
        sessions.set(session.id, session);
        return status(session);
      } catch (error) {
        reserved -= input.file_size;
        if (assetId) {
          try { await context.request("/" + definition.api + "/" + definition.type + "/" + assetId, { method: "DELETE" }); }
          catch { throw new PublicError("Image reservation failed; inspect and remove reserved image " + assetId + "."); }
        }
        throw error;
      }
    })();
    starting.set(fingerprint, job);
    try { return await job; } finally { starting.delete(fingerprint); }
  }

  async function commit(session, context) {
    if (session.received !== session.input.file_size) throw new PublicError("Image upload is incomplete.");
    await context.verify(session.app, session.parentKind, session.input.parent_id, true);
    if (!session.committed) {
      if (session.bytes) {
        if (createHash("sha256").update(session.bytes).digest("hex") !== session.input.sha256) throw new PublicError("Image checksum mismatch.");
        validateImage(session.bytes, session.input.target);
      }
      // A previous commit may have succeeded even if its response was lost.
      const current = (await context.request(path(session)))?.data;
      const state = current?.attributes?.assetDeliveryState?.state;
      if (state && state !== "AWAITING_UPLOAD") {
        session.committed = true;
      } else {
        if (!session.sent) {
          for (const operation of session.operations) {
            const response = await fetchImpl(operation.url, {
              method: "PUT", redirect: "error",
              headers: Object.fromEntries(operation.requestHeaders.map(header => [header.name, header.value])),
              body: session.bytes.subarray(operation.offset, operation.offset + operation.length),
              signal: AbortSignal.timeout(30_000)
            });
            await response.body?.cancel();
            if (!response.ok) throw new PublicError("Apple image transfer failed. Retry this upload session.");
          }
          session.sent = true;
        }
        await context.request(path(session), {
          method: "PATCH",
          body: { data: { type: session.definition.type, id: session.assetId, attributes: { uploaded: true } } }
        });
        session.committed = true;
      }
      if (session.bytes) { reserved -= session.bytes.length; session.bytes = null; }
      context.invalidate();
    }
    let state;
    for (let poll = 0; poll < 4; poll++) {
      const resource = (await context.request(path(session)))?.data;
      if (resource?.id !== session.assetId || resource.type !== session.definition.type) throw new PublicError("Unexpected image status.");
      state = resource.attributes?.assetDeliveryState?.state;
      if (state === "COMPLETE" || state === "FAILED") break;
      if (poll < 3) await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { ...status(session), assetDeliveryState: { state: state || "UNKNOWN" } };
  }

  return {
    has: operation => Object.hasOwn(schemas, operation) || media.has(operation),
    sessionTarget(alias, uploadId) {
      const session = sessions.get(uploadId);
      return session?.alias === alias && session.expires > now() ? session.input.target : media.sessionTarget(alias, uploadId);
    },
    close() { clearInterval(timer); return media.close(); },
    async call(alias, app, operation, raw, context) {
      if (media.has(operation)) return media.call(alias, app, operation, raw, context);
      const parsed = schemas[operation]?.safeParse(raw);
      if (!parsed?.success) throw new PublicError("Invalid image upload arguments.");
      const input = parsed.data;
      if (operation === "_image_begin") return begin(alias, app, input, context);
      expire();
      const session = sessions.get(input.upload_id);
      if (!session || session.app !== app || session.alias !== alias) throw new PublicError("Unknown or expired image upload session.");
      if (session.busy) throw new PublicError("Image upload session is busy.");
      session.expires = now() + 600_000;
      if (operation === "_image_chunk") {
        if (session.committed) return status(session);
        const bytes = Buffer.from(input.base64, "base64");
        if (bytes.length > 32 * 1024 || input.offset + bytes.length > session.input.file_size) throw new PublicError("Invalid image chunk length.");
        if (input.offset < session.received) {
          if (input.offset + bytes.length > session.received || !bytes.equals(session.bytes.subarray(input.offset, input.offset + bytes.length))) throw new PublicError("Image retry chunk differs.");
        } else {
          if (input.offset !== session.received) throw new PublicError("Image chunks must be sequential.");
          bytes.copy(session.bytes, input.offset);
          session.received += bytes.length;
        }
        return status(session);
      }
      session.busy = true;
      try {
        if (operation === "_image_cancel") {
          await context.verify(app, session.parentKind, session.input.parent_id, true);
          await context.request(path(session), { method: "DELETE" });
          remove(session);
          context.invalidate();
          return { cancelled: true };
        }
        return await commit(session, context);
      } finally { session.busy = false; }
    }
  };
}
