import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUploads} from './asc-uploads.mjs';
import {createRuntime} from './asc-runtime.mjs';
import {bridgeMediaUpload} from './asc-bridge-upload.mjs';

const config=(deny=[],allow=['read:*','screenshots','video-previews'])=>({apps:{fixture:{id:'123',policy:'edit'},other:{id:'456',policy:'edit'}},policies:{edit:{allow,deny}}});
function bytesFor(preview=false,size=70000){
 const bytes=Buffer.alloc(size,17);
 if(preview){bytes.writeUInt32BE(24,0);bytes.write('ftyp',4);bytes.write('isom',8);}
 else {Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(1284,16);bytes.writeUInt32BE(2778,20);}
 return bytes;
}
function fixture({preview=false,bytes=bytesFor(preview),deny=[],allow,fetchImpl,now}={}){
 const type=preview?'appPreviews':'appScreenshots',setType=preview?'appPreviewSets':'appScreenshotSets';
 const calls=[],transfers=[];let committed=false,foreign=false,failTransfer=false,lostCommit=false,malicious=false,pending=false;
 const request=async(path,options={})=>{
  calls.push({path,...options});
  if(path.startsWith('/v1/'+setType+'/'))return {data:{type:setType,id:'set',relationships:{appStoreVersionLocalization:{data:{type:'appStoreVersionLocalizations',id:'loc'}}}}};
  if(path.startsWith('/v1/appStoreVersionLocalizations/'))return {data:{type:'appStoreVersionLocalizations',id:'loc',relationships:{appStoreVersion:{data:{type:'appStoreVersions',id:'version'}}}}};
  if(path.startsWith('/v1/appStoreVersions/'))return {data:{type:'appStoreVersions',id:'version',relationships:{app:{data:{type:'apps',id:foreign?'999':'123'}}}}};
  if(options.method==='POST')return {data:{type,id:'asset',attributes:{uploadOperations:[
   {url:malicious?'https://localhost/leak':'https://store-001.blobstore.apple.com/part1?signature=private',method:'PUT',offset:0,length:24000,requestHeaders:[{name:'Content-Type',value:'application/octet-stream'}]},
   {url:'https://northamerica-1.object-storage.apple.com/part2?token=private',method:'PUT',offset:24000,length:options.body.data.attributes.fileSize-24000,requestHeaders:[]}
  ]}}};
  if(options.method==='PATCH'){committed=true;if(lostCommit){lostCommit=false;throw new Error('Lost commit response');}return {};}
  if(options.method==='DELETE')return {};
  return {data:{type,id:'asset',attributes:{assetDeliveryState:{state:committed?(pending?'UPLOAD_COMPLETE':'COMPLETE'):'AWAITING_UPLOAD'}}}};
 };
 const uploadFetch=fetchImpl||(async(url,init)=>{
  assert.equal(init.redirect,'error');assert.equal(init.duplex,'half');assert.equal(init.headers.Authorization,undefined);
  const file=init.body.path;assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await stat(join(file,'..'))).mode&0o777,0o700);
  const parts=[];for await(const part of init.body)parts.push(part);
  assert.equal(Number(init.headers['content-length']),Buffer.concat(parts).length);transfers.push({url,bytes:Buffer.concat(parts),file});
  if(failTransfer){failTransfer=false;throw new Error('https://signed-url.example?token=private SYNTHETIC_SECRET');}
  return new Response(null,{status:200});
 });
 const uploads=createUploads(uploadFetch,now?{now}:{});
 const runtime=createRuntime(config(deny,allow),request,uploads);
 const input={target:preview?'preview_set':'screenshot_set',parent_id:'set',file_name:preview?'preview.mp4':'screen.png',file_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 return {runtime,uploads,bytes,input,calls,transfers,request,uploadFetch,
  set foreign(value){foreign=value;},set failTransfer(value){failTransfer=value;},set lostCommit(value){lostCommit=value;},set malicious(value){malicious=value;},set pending(value){pending=value;},
  async begin(overrides={}){return runtime.call('fixture','_media_begin',{...input,...overrides});},
  async chunks(session){for(let offset=session.received;offset<bytes.length;offset+=32768)await runtime.call('fixture','_media_chunk',{upload_id:session.upload_id,offset,base64:bytes.subarray(offset,offset+32768).toString('base64')});}
 };
}

for(const preview of [false,true])test((preview?'video preview':'screenshot')+' reserves, streams multipart bytes, commits MD5 and cleans private spool',async()=>{
 const f=fixture({preview});
 try {
  const session=await f.begin(preview?{preview_frame_time_code:'00:00:05:00'}:{});
  assert.deepEqual(await f.begin(preview?{preview_frame_time_code:'00:00:05:00'}:{}),session);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.ok(!JSON.stringify(session).includes('signature'));
  const reservation=f.calls.find(c=>c.method==='POST').body.data;
  assert.deepEqual(reservation.relationships[preview?'appPreviewSet':'appScreenshotSet'].data,{type:preview?'appPreviewSets':'appScreenshotSets',id:'set'});
  if(preview){assert.equal(reservation.attributes.mimeType,'video/mp4');assert.equal(reservation.attributes.previewFrameTimeCode,'00:00:05:00');}
  const ownershipCalls=f.calls.length;await f.chunks(session);assert.equal(f.calls.length,ownershipCalls,'chunks must not issue ownership API requests');
  const result=await f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id});
  assert.equal(result.assetDeliveryState.state,'COMPLETE');
  assert.deepEqual(Buffer.concat(f.transfers.map(t=>t.bytes)),f.bytes);
  const commit=f.calls.find(c=>c.method==='PATCH').body.data.attributes;
  assert.deepEqual(commit,{uploaded:true,sourceFileChecksum:createHash('md5').update(f.bytes).digest('hex')});
  await assert.rejects(stat(f.transfers[0].file),{code:'ENOENT'});
  await f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id});assert.equal(f.transfers.length,2);
 }finally{await f.uploads.close();}
});

test('preview bridge streams a file larger than the old 20 MiB image limit',async()=>{
 const f=fixture({preview:true,bytes:bytesFor(true,21*1024*1024)});const dir=await mkdtemp(join(tmpdir(),'asc-media-source-'));
 try {
  const file=join(dir,'preview.mov');await writeFile(file,f.bytes);
  const calls=[];
  const call=async(operation,input)=>{calls.push(operation);return {result:await f.runtime.call('fixture',operation,input)};};
  const result=await bridgeMediaUpload(call,'upload_video_preview',{set_id:'set',file_path:file});
  assert.equal(result.result.assetDeliveryState.state,'COMPLETE');
  assert.equal(f.calls.find(c=>c.method==='POST').body.data.attributes.mimeType,'video/quicktime');
  assert.ok(calls.filter(op=>op==='_media_chunk').length>600);
  assert.deepEqual(Buffer.concat(f.transfers.map(t=>t.bytes)),f.bytes);
 }finally{await f.uploads.close();await rm(dir,{recursive:true,force:true});}
});

test('media ownership, alias and policy checks cannot be bypassed with private operations',async()=>{
 const f=fixture();
 try{
  f.foreign=true;await assert.rejects(f.begin(),/ownership/i);assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }finally{await f.uploads.close();}
 const valid=fixture();
 try {
  const session=await valid.begin();
  await assert.rejects(valid.runtime.call('other','_media_commit',{upload_id:session.upload_id}),/target|session/);
  await assert.rejects(valid.runtime.call('fixture','_image_commit',{upload_id:session.upload_id}),/target/);
  for(const operation of ['_media_chunk','_media_commit','_media_cancel']){
   const restricted=createRuntime(config(['write:screenshots']),valid.request,valid.uploads);
   await assert.rejects(restricted.call('fixture',operation,{upload_id:session.upload_id}),/policy/);
  }
  const gameCenter=createRuntime(config([],['game-center']),valid.request,valid.uploads);
  await assert.rejects(gameCenter.call('fixture','_media_begin',valid.input),/policy/);
  const teamConfig={...config(),team:{enabled:true,policy:'edit'}};
  const team=createRuntime(teamConfig,valid.request,valid.uploads);
  assert.ok(!team.definitions('@team').some(t=>t.name==='upload_screenshot'));
  await assert.rejects(team.call('@team','_media_begin',valid.input),/policy/);
  const read=createRuntime(config([],['read:*']),valid.request,valid.uploads);
  assert.ok(!read.definitions('fixture').some(t=>t.name==='upload_screenshot'));
  await assert.rejects(read.call('fixture','_media_begin',valid.input),/policy/);
  const onlyPreview=createRuntime(config(['screenshots'],['*']),valid.request,valid.uploads);
  assert.ok(onlyPreview.definitions('fixture').some(t=>t.name==='upload_video_preview'));
  assert.ok(!onlyPreview.definitions('fixture').some(t=>t.name==='upload_screenshot'));
  const legacy=createRuntime({apps:{fixture:'123'}},valid.request,valid.uploads);
  assert.ok(!legacy.definitions('fixture').some(t=>t.name==='upload_screenshot'));
  await assert.rejects(legacy.call('fixture','_media_begin',valid.input),/policy/);
 }finally{await valid.uploads.close();}
});

test('media retries recover transfer/commit errors, polling and cancellation',async()=>{
 const f=fixture({preview:true});
 try {
  const session=await f.begin();await f.chunks(session);f.failTransfer=true;
  await assert.rejects(f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id}),error=>/Retry/.test(error.message)&&!error.message.includes('SYNTHETIC_SECRET')&&!error.message.includes('signed-url'));
  f.lostCommit=true;f.pending=true;
  await assert.rejects(f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id}),/Lost commit/);
  const sent=f.transfers.length;
  const pending=await f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id});assert.equal(pending.assetDeliveryState.state,'UPLOAD_COMPLETE');assert.equal(f.transfers.length,sent);
  f.pending=false;assert.equal((await f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id})).assetDeliveryState.state,'COMPLETE');
  assert.deepEqual(await f.runtime.call('fixture','_media_cancel',{upload_id:session.upload_id}),{cancelled:true});
  await assert.rejects(f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id}),/target|session/);
 }finally{await f.uploads.close();}
});

test('media rejects invalid instructions, corrupt bytes, wrong offsets and mismatched retries',async()=>{
 const malicious=fixture();
 try {malicious.malicious=true;await assert.rejects(malicious.begin(),/upload URL/i);assert.ok(malicious.calls.some(c=>c.method==='DELETE'));assert.equal(malicious.transfers.length,0);}finally{await malicious.uploads.close();}
 const f=fixture();
 try {
  const session=await f.begin({sha256:'0'.repeat(64)});
  await assert.rejects(f.runtime.call('fixture','_media_chunk',{upload_id:session.upload_id,offset:10,base64:'AAAA'}),/sequential/);
  const chunk={upload_id:session.upload_id,offset:0,base64:f.bytes.subarray(0,32768).toString('base64')};
  await f.runtime.call('fixture','_media_chunk',chunk);await f.runtime.call('fixture','_media_chunk',chunk);
  await assert.rejects(f.runtime.call('fixture','_media_chunk',{...chunk,base64:Buffer.alloc(32768).toString('base64')}),/differs/);
  await f.chunks({...session,received:32768});
  await assert.rejects(f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id}),/checksum/);assert.equal(f.transfers.length,0);
 }finally{await f.uploads.close();}
});

test('media sessions expire and cannot be reused',async()=>{
 let now=0;const f=fixture({now:()=>now});
 try {const s=await f.begin();now=31*60*1000;await assert.rejects(f.runtime.call('fixture','_media_cancel',{upload_id:s.upload_id}),/target|session/);}
 finally{await f.uploads.close();}
});



import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {createDaemon} from './asc-daemon.mjs';
for(const preview of [false,true])test('MCP bridge uploads '+(preview?'a video preview':'a screenshot')+' using a fake daemon and fake Apple',async()=>{
 const f=fixture({preview});const dir=await mkdtemp(join(tmpdir(),'asc-media-mcp-'));const socket=join(dir,'service.sock');
 const server=createDaemon(config(),{request:f.request,uploadFetch:f.uploadFetch,mayReturn:()=>true});
 const client=new Client({name:'media-test',version:'1.0.0'},{capabilities:{}});
 await new Promise(resolve=>server.listen(socket,resolve));
 try {
  const file=join(dir,preview?'preview.mp4':'screenshot.png');await writeFile(file,f.bytes);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./asc-bridge.mjs',import.meta.url)),'fixture',socket],env:{PATH:process.env.PATH}}));
  const discovery=await client.listTools();
  const name=preview?'upload_video_preview':'upload_screenshot';
  assert.ok(discovery.tools.some(t=>t.name===name));
  const response=await client.callTool({name,arguments:{set_id:'set',file_path:file}});
  assert.ok(!response.isError,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text);
  assert.equal(result.assetDeliveryState.state,'COMPLETE');
  assert.ok(!JSON.stringify(response).includes('signature'));
  assert.ok(!JSON.stringify(f.calls).includes(file),'local source path must not reach Apple');
  assert.deepEqual(Buffer.concat(f.transfers.map(t=>t.bytes)),f.bytes);
  const cancelled=await client.callTool({name:'cancel_media_upload',arguments:{upload_id:result.upload_id}});
  assert.ok(!cancelled.isError,JSON.stringify(cancelled));
 }finally{await client.close();await new Promise(resolve=>server.close(resolve));await f.uploads.close();await rm(dir,{recursive:true,force:true});}
});


test('completed uploads release capacity for a full screenshot set',async()=>{
 const f=fixture();
 try {
  for(let index=0;index<10;index++){
   const session=await f.begin({file_name:'screen-'+index+'.png'});await f.chunks(session);
   assert.equal((await f.runtime.call('fixture','_media_commit',{upload_id:session.upload_id})).assetDeliveryState.state,'COMPLETE');
  }
 }finally{await f.uploads.close();}
});

import {mkdir,readdir,readFile} from 'node:fs/promises';
test('private service spools clean orphan files on startup and owned files on cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'asc-spool-test-'));
 const directory=join(root,'asc-media-ABC123');await mkdir(directory);await writeFile(join(directory,'asset'),'orphan');
 await writeFile(join(root,'unrelated'),'preserved');
 const uploads=createUploads(async()=>{throw new Error('No transfer expected');},{mediaDirectory:root});
 const f=fixture();const runtime=createRuntime(config(),f.request,uploads);
 try {
  const session=await runtime.call('fixture','_media_begin',f.input);
  await assert.rejects(stat(directory),{code:'ENOENT'});
  const files=await readdir(root);const spool=files.find(name=>name.startsWith('asc-media-'));assert.ok(spool);
  assert.equal((await stat(join(root,spool))).mode&0o777,0o700);
  await runtime.call('fixture','_media_cancel',{upload_id:session.upload_id});
  assert.deepEqual(await readdir(root),['unrelated']);
  assert.equal(await readFile(join(root,'unrelated'),'utf8'),'preserved');
 }finally{await uploads.close();await f.uploads.close();await rm(root,{recursive:true,force:true});}
});


test('media rejects unsupported files and bounds active reservations without allocating whole previews',async()=>{
 const f=fixture({preview:true});
 try {
  for(const patch of [{file_name:'preview.png'},{file_size:501*1024*1024},{preview_frame_time_code:'invalid'}]) await assert.rejects(f.begin(patch),/preview|arguments/i);
  assert.equal(f.calls.length,0);
  const first=await f.begin({file_size:500*1024*1024,file_name:'first.mp4'});
  await f.begin({file_size:500*1024*1024,file_name:'second.mp4'});
  await assert.rejects(f.begin({file_size:500*1024*1024,file_name:'third.mp4'}),/capacity/);
  await f.runtime.call('fixture','_media_cancel',{upload_id:first.upload_id});
  await f.begin({file_size:500*1024*1024,file_name:'third.mp4'});
  assert.equal(f.transfers.length,0);
 }finally{await f.uploads.close();}
 const invalid=fixture({bytes:Buffer.alloc(70000)});
 try{const session=await invalid.begin();await invalid.chunks(session);await assert.rejects(invalid.runtime.call('fixture','_media_commit',{upload_id:session.upload_id}),/PNG or JPEG/);assert.equal(invalid.transfers.length,0);}
 finally{await invalid.uploads.close();}
});


test('preview polling supports videoDeliveryState without the deprecated asset state',async()=>{
 const f=fixture({preview:true});
 let processing=true;
 const request=async(path,options)=>{
  const response=await f.request(path,options);
  if(path==='/v1/appPreviews/asset' && !options?.method){
   const previous=response.data.attributes.assetDeliveryState.state;
   delete response.data.attributes.assetDeliveryState;
   response.data.attributes.videoDeliveryState={state:previous==='AWAITING_UPLOAD'?previous:processing?'PROCESSING':'COMPLETE'};
  }
  return response;
 };
 const runtime=createRuntime(config(),request,f.uploads);
 try {
  const session=await runtime.call('fixture','_media_begin',f.input);await f.chunks(session);
  const first=await runtime.call('fixture','_media_commit',{upload_id:session.upload_id});
  assert.equal(first.state,'PROCESSING');assert.equal(first.videoDeliveryState.state,'PROCESSING');
  processing=false;
  const result=await runtime.call('fixture','_media_commit',{upload_id:session.upload_id});
  assert.equal(result.state,'COMPLETE');assert.equal(result.videoDeliveryState.state,'COMPLETE');
  assert.equal(f.transfers.length,2);
 }finally{await f.uploads.close();}
});
