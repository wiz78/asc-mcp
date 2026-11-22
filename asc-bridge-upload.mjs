import { open } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { imageTarget, maxImageBytes } from "./asc-uploads.mjs";

export const bridgeUploadTools = {
  upload_game_center_image: ["Upload a PNG/JPEG from a local file. The bridge reads it with your permissions. Retry with the same file and target to resume an active session.", z.strictObject({
    target: imageTarget,
    parent_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    file_path: z.string().startsWith("/").max(4096)
  })],
  finish_game_center_image_upload: ["Retry transfer/commit or poll an active image session returned by upload_game_center_image.", z.strictObject({ upload_id: z.string().uuid() })],
  cancel_game_center_image_upload: ["Remove an active reserved image and cancel its upload session.", z.strictObject({ upload_id: z.string().uuid() })]
};

export async function bridgeUpload(call, operation, input) {
  if (operation === "finish_game_center_image_upload") return call("_image_commit", input);
  if (operation === "cancel_game_center_image_upload") return call("_image_cancel", input);
  let bytes;
  try {
    const file = await open(input.file_path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxImageBytes || stat.size < 24) {
        return { error: "Use a PNG/JPEG file no larger than 20 MiB." };
      }
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return { error: "Image file changed while reading." };
        offset += bytesRead;
      }
    } finally { await file.close(); }
  } catch {
    return { error: "Cannot read the local image file with the bridge's permissions." };
  }
  const start = await call("_image_begin", {
    target: input.target, parent_id: input.parent_id,
    file_name: basename(input.file_path), file_size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
  if (start.error) return start;
  const session = start.result;
  for (let offset = session.received; offset < bytes.length; offset += 32 * 1024) {
    const response = await call("_image_chunk", {
      upload_id: session.upload_id, offset,
      base64: bytes.subarray(offset, offset + 32 * 1024).toString("base64")
    });
    if (response.error) return { ...response, error: response.error + " Image " + session.asset_id + ". Resume or cancel upload " + session.upload_id + "." };
  }
  const result = await call("_image_commit", { upload_id: session.upload_id });
  if (result.error) return { ...result, error: result.error + " Image " + session.asset_id + ". Resume or cancel upload " + session.upload_id + "." };
  return result;
}

// Media files are read only by the unprivileged bridge. No file path is sent
// to the daemon, and Apple upload URLs never cross back to the bridge.
export const mediaUploadTools = {
  upload_screenshot: ['Upload a local PNG/JPEG screenshot to an owned screenshot set, transfer bytes and commit. Retry the same file/set to resume. Apple validates display dimensions.', z.strictObject({set_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),file_path:z.string().startsWith('/').max(4096)})],
  upload_video_preview: ['Upload a local MOV/MP4/M4V app preview to an owned preview set, transfer bytes and commit. Apple validates codecs, duration and dimensions. Processing may continue after return.', z.strictObject({set_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),file_path:z.string().startsWith('/').max(4096),preview_frame_time_code:z.string().regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/).optional()})],
  finish_media_upload: ['Retry transfer/commit or poll processing for an active screenshot or video preview upload session.', z.strictObject({upload_id:z.string().uuid()})],
  cancel_media_upload: ['Delete a reserved screenshot/video preview and clean up its upload session.', z.strictObject({upload_id:z.string().uuid()})]
};

export async function bridgeMediaUpload(call,operation,input) {
  if(operation==='finish_media_upload') return call('_media_commit',input);
  if(operation==='cancel_media_upload') return call('_media_cancel',input);
  const preview=operation==='upload_video_preview';
  const limit=preview?500*1024*1024:20*1024*1024;
  let file;
  try {file=await open(input.file_path,'r');}catch{return {error:'Cannot read the local media file with the bridge permissions.'};}
  try {
    const stat=await file.stat();
    if(!stat.isFile() || stat.size<24 || stat.size>limit) return {error:preview?'Use a preview file between 24 bytes and 500 MiB.':'Use a screenshot file between 24 bytes and 20 MiB.'};
    const hash=createHash('sha256');const buffer=Buffer.alloc(32768);
    let offset=0;
    while(offset<stat.size) {
      const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);
      if(!bytesRead) return {error:'Media file changed while reading.'};
      hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;
    }
    const args={target:preview?'preview_set':'screenshot_set',parent_id:input.set_id,file_name:basename(input.file_path),file_size:stat.size,sha256:hash.digest('hex')};
    if(input.preview_frame_time_code!==undefined) args.preview_frame_time_code=input.preview_frame_time_code;
    const start=await call('_media_begin',args);if(start.error) return start;
    const session=start.result;
    const withSession=response=>response.error?{...response,error:response.error+' Asset '+session.asset_id+'. Resume or cancel upload '+session.upload_id+'.'}:response;
    for(offset=session.received;offset<stat.size;) {
      const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);
      if(!bytesRead) return withSession({error:'Media file changed while reading.'});
      const result=await call('_media_chunk',{upload_id:session.upload_id,offset,base64:buffer.subarray(0,bytesRead).toString('base64')});
      if(result.error) return withSession(result);
      offset+=bytesRead;
    }
    return withSession(await call('_media_commit',{upload_id:session.upload_id}));
  }finally{await file.close();}
}
