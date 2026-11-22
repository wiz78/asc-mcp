import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,open,rm,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {PublicError} from './asc-errors.mjs';
import {mediaTargets,maxPreviewBytes,maxScreenshotBytes} from './asc-media-types.mjs';

const sessionSchema=z.strictObject({upload_id:z.string().uuid()});
const beginSchema=z.strictObject({
 target:z.enum(['screenshot_set','preview_set']),parent_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
 file_name:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,180}\.(?:png|jpg|jpeg|mov|mp4|m4v)$/i),
 file_size:z.number().int().min(24).max(maxPreviewBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/),
 preview_frame_time_code:z.string().regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/).optional()
});
const schemas={_media_begin:beginSchema,_media_commit:sessionSchema,_media_cancel:sessionSchema,
 _media_chunk:sessionSchema.extend({offset:z.number().int().min(0).max(maxPreviewBytes),base64:z.string().min(4).max(44000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)})};
const ttl=30*60*1000;
const quota=1024*1024*1024;

export function createMediaUploads(fetchImpl,validateOperations,{now=Date.now,root}={}) {
 const sessions=new Map(),starting=new Map(); let reserved=0,closed=false;
 // The installed service supplies its private state directory. A prior process
 // cannot resume its in-memory sessions, so remove only its orphan spool names.
 const ready=root ? readdir(root,{withFileTypes:true}).then(entries=>Promise.all(entries.filter(entry=>/^asc-media-[A-Za-z0-9]{6}$/.test(entry.name)).map(entry=>rm(join(root,entry.name),{recursive:true,force:true})))) : Promise.resolve();
 // Keep startup errors observable on the first upload without unhandled rejection.
 ready.catch(()=>{});
 const status=s=>({upload_id:s.id,asset_id:s.assetId,received:s.received});
 const path=s=>'/v1/'+s.definition.type+'/'+s.assetId;
 async function discardBytes(s) {
  if(s.directory) {const directory=s.directory;s.directory=null;await rm(directory,{recursive:true,force:true});reserved-=s.input.file_size;}
 }
 async function remove(s) {await discardBytes(s);sessions.delete(s.id);}
 async function expire() {for(const s of sessions.values()) if(!s.busy && s.expires<=now()) await remove(s);}
 const timer=setInterval(()=>{expire().catch(()=>{});},30000).unref();
 async function begin(alias,app,input,context) {
  if(input.target==='screenshot_set' && (input.file_size>maxScreenshotBytes || !/\.(png|jpe?g)$/i.test(input.file_name) || input.preview_frame_time_code!==undefined)) throw new PublicError('Use a PNG/JPEG screenshot no larger than 20 MiB.');
  if(input.target==='preview_set' && !/\.(mov|mp4|m4v)$/i.test(input.file_name)) throw new PublicError('Use a MOV, MP4 or M4V preview no larger than 500 MiB.');
  await ready;await expire();
  const fingerprint=JSON.stringify([alias,app,input]);
  for(const s of sessions.values()) if(s.fingerprint===fingerprint) return status(s);
  if(starting.has(fingerprint)) return starting.get(fingerprint);
  // Reserve capacity before asynchronous ownership, reservation or disk operations.
  if(closed || [...sessions.values()].filter(s=>s.directory).length+starting.size>=8 || sessions.size>=1024 || reserved+input.file_size>quota) throw new PublicError('Media upload capacity reached. Finish or cancel an upload.');
  reserved+=input.file_size;
  const job=(async()=>{
   let directory,assetId;
   const definition=mediaTargets[input.target];
   try {
    const parent=await context.verify(app,input.target,input.parent_id,true);
    directory=await mkdtemp(join(root||tmpdir(),'asc-media-'));
    const file=await open(join(directory,'asset'),'wx',0o600);await file.close();
    const attributes={fileSize:input.file_size,fileName:input.file_name};
    if(input.target==='preview_set') {
     attributes.mimeType=/\.mov$/i.test(input.file_name)?'video/quicktime':'video/mp4';
     if(input.preview_frame_time_code!==undefined) attributes.previewFrameTimeCode=input.preview_frame_time_code;
    }
    const resource=(await context.request('/v1/'+definition.type,{method:'POST',body:{data:{type:definition.type,attributes,relationships:{[definition.relation]:{data:{type:parent.type,id:parent.id}}}}}}))?.data;
    if(resource?.type!==definition.type || !/^[A-Za-z0-9_-]{1,128}$/.test(resource?.id||'')) throw new PublicError('Invalid Apple media reservation.');
    assetId=resource.id;
    validateOperations(resource.attributes?.uploadOperations,input.file_size);
    if(closed) throw new PublicError('Media upload service is closing.');
    const s={id:randomUUID(),alias,app,input,definition,assetId,directory,fingerprint,operations:resource.attributes.uploadOperations,
     received:0,expires:now()+ttl,busy:false,sent:false,committed:false};
    sessions.set(s.id,s);return status(s);
   } catch(error) {
    reserved-=input.file_size;
    if(directory) await rm(directory,{recursive:true,force:true});
    if(assetId) {try{await context.request('/v1/'+definition.type+'/'+assetId,{method:'DELETE'});}catch{throw new PublicError('Media reservation failed; inspect and remove reserved asset '+assetId+'.');}}
    if(error instanceof PublicError) throw error;
    throw new PublicError('Media reservation failed. Check ownership and retry.');
   }
  })();
  starting.set(fingerprint,job);
  try{return await job;}finally{starting.delete(fingerprint);}
 }
 async function checksumAndValidate(s) {
  const sha=createHash('sha256'),md5=createHash('md5');let head=Buffer.alloc(0);
  for await(const bytes of createReadStream(join(s.directory,'asset'))) {
   if(head.length<32) head=Buffer.concat([head,bytes.subarray(0,32-head.length)]);
   sha.update(bytes);md5.update(bytes);
  }
  if(sha.digest('hex')!==s.input.sha256) throw new PublicError('Media checksum mismatch.');
  if(s.input.target==='screenshot_set') {
   const png=head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && head.subarray(12,16).toString()==='IHDR' && head.readUInt32BE(16)>0 && head.readUInt32BE(20)>0;
   const jpeg=head[0]===255 && head[1]===216 && head[2]===255;
   if(!png && !jpeg) throw new PublicError('Use a PNG or JPEG screenshot.');
  } else if(!['ftyp','wide','moov','mdat'].includes(head.subarray(4,8).toString())) throw new PublicError('Use a MOV, MP4 or M4V preview.');
  return md5.digest('hex');
 }
 function resourceStatus(resource,s) {
  if(resource?.id!==s.assetId || resource.type!==s.definition.type) throw new PublicError('Unexpected media status.');
  const attributes=resource.attributes||{};
  const accepted=new Set(['AWAITING_UPLOAD','UPLOAD_COMPLETE','PROCESSING','COMPLETE','FAILED']);
  const asset=accepted.has(attributes.assetDeliveryState?.state)?attributes.assetDeliveryState.state:undefined;
  const video=accepted.has(attributes.videoDeliveryState?.state)?attributes.videoDeliveryState.state:undefined;
  return {asset,video,state:s.input.target==='preview_set'?(video||asset):asset};
 }
 async function commit(s,context) {
  if(s.received!==s.input.file_size) throw new PublicError('Media upload is incomplete.');
  await context.verify(s.app,s.input.target,s.input.parent_id,true);
  if(!s.committed) {
   const md5=await checksumAndValidate(s);
   const {state}=resourceStatus((await context.request(path(s)))?.data,s);
   if(state && state!=='AWAITING_UPLOAD') s.committed=true;
   else {
    if(!s.sent) {
     for(const operation of s.operations) {
      const body=createReadStream(join(s.directory,'asset'),{start:operation.offset,end:operation.offset+operation.length-1});
      try {
       const headers=Object.fromEntries(operation.requestHeaders.map(h=>[h.name.toLowerCase(),h.value]));
       headers['content-length']=String(operation.length);
       const response=await fetchImpl(operation.url,{method:'PUT',redirect:'error',duplex:'half',headers,body,signal:AbortSignal.timeout(120000)});
       await response.body?.cancel();
       if(!response.ok) throw new Error('Transfer failed');
      } catch {throw new PublicError('Apple media transfer failed. Retry this upload session.');}
      finally {body.destroy();}
     }
     s.sent=true;
    }
    await context.request(path(s),{method:'PATCH',body:{data:{type:s.definition.type,id:s.assetId,attributes:{uploaded:true,sourceFileChecksum:md5}}}});
    s.committed=true;
   }
   await discardBytes(s);context.invalidate();
  }
  // Processing may take minutes. Let clients poll without holding the MCP call.
  const delivery=resourceStatus((await context.request(path(s)))?.data,s);
  return {...status(s),state:delivery.state||'UNKNOWN',
   ...(delivery.asset?{assetDeliveryState:{state:delivery.asset}}:{}),
   ...(delivery.video?{videoDeliveryState:{state:delivery.video}}:{})};
 }
 return {
  has:operation=>Object.hasOwn(schemas,operation),
  sessionTarget(alias,id){const s=sessions.get(id);return s?.alias===alias && s.expires>now()?s.input.target:undefined;},
  async close(){closed=true;clearInterval(timer);await ready.catch(()=>{});await Promise.allSettled([...starting.values()]);await Promise.allSettled([...sessions.values()].map(remove));},
  async call(alias,app,operation,raw,context) {
   const parsed=schemas[operation]?.safeParse(raw);if(!parsed?.success) throw new PublicError('Invalid media upload arguments.');
   const input=parsed.data;
   if(operation==='_media_begin') return begin(alias,app,input,context);
   await expire();const s=sessions.get(input.upload_id);
   if(!s || s.alias!==alias || s.app!==app || closed) throw new PublicError('Unknown or expired media upload session.');
   if(s.busy) throw new PublicError('Media upload session is busy.');
   s.busy=true;s.expires=now()+ttl;
   try {
    if(operation==='_media_chunk') {
     if(s.committed) return status(s);
     const bytes=Buffer.from(input.base64,'base64');
     if(bytes.length>32768 || input.offset+bytes.length>s.input.file_size) throw new PublicError('Invalid media chunk length.');
     const file=await open(join(s.directory,'asset'),'r+');
     try {
      if(input.offset<s.received) {
       const previous=Buffer.alloc(bytes.length);const {bytesRead}=await file.read(previous,0,bytes.length,input.offset);
       if(input.offset+bytes.length>s.received || bytesRead!==bytes.length || !bytes.equals(previous)) throw new PublicError('Media retry chunk differs.');
      } else {
       if(input.offset!==s.received) throw new PublicError('Media chunks must be sequential.');
       let written=0;while(written<bytes.length){const result=await file.write(bytes,written,bytes.length-written,input.offset+written);if(!result.bytesWritten)throw new PublicError('Media spool write failed.');written+=result.bytesWritten;}
       s.received+=bytes.length;
      }
     }finally{await file.close();}
     return status(s);
    }
    if(operation==='_media_cancel') {
     await context.verify(app,s.input.target,s.input.parent_id,true);
     await context.request(path(s),{method:'DELETE'});await remove(s);context.invalidate();return {cancelled:true};
    }
    return await commit(s,context);
   } finally{s.busy=false;}
  }
 };
}
