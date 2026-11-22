import {test} from 'node:test';
import {Socket} from 'node:net';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverTools,inspect} from './asc-inspect.mjs';

test('inspection only requests discovery, formats status and filters tool definitions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'asc-inspect-')); const socketPath=join(dir,'service.sock');
 const calls=[];
 const tools=[{name:'z_tool',description:'Screenshots management'},{name:'a_tool',description:'Metadata'}];
 const server=createServer(async(req,res)=>{
  let body=''; for await(const chunk of req) body+=chunk;
  const call=JSON.parse(body); calls.push(call);
  assert.equal(req.url,'/call');assert.equal(req.method,'POST');
  res.setHeader('Content-Type','application/json');
  if(call.app==='denied') {res.statusCode=400;res.end(JSON.stringify({error:'Unknown app alias.'}));}
  else if(call.app==='invalid') res.end('{}');
  else res.end(JSON.stringify({result:{tools}}));
 });
 await new Promise(resolve=>server.listen(socketPath,resolve));
 try {
  const output=[];const write=value=>output.push(value);
  await inspect('status',['example','--socket',socketPath],write);
  assert.equal(output.pop(),'Daemon reachable; scope example exposes 2 tools.');
  await inspect('tools',['example','--socket',socketPath,'--filter','SCREENSHOT'],write);
  assert.equal(output.pop(),'z_tool');
  await inspect('tools',['--team','--socket',socketPath,'--json'],write);
  assert.deepEqual(JSON.parse(output.pop()).map(t=>t.name),['a_tool','z_tool']);
  assert.equal(calls.at(-1).app,'@team');
  await assert.rejects(discoverTools('denied',{socketPath}),/Unknown app alias/);
  await assert.rejects(discoverTools('invalid',{socketPath}),/Invalid daemon discovery/);
  await assert.rejects(inspect('tools',['example','--socket']),/Missing value/);
  await assert.rejects(inspect('tools',['example','--unknown']),/Unknown option/);
  assert.ok(calls.every(call=>call.operation==='_catalog' && Object.keys(call.input).length===0));
 } finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
 await assert.rejects(discoverTools('example',{socketPath}),/Local ASC daemon unavailable/);
});

test('account-free guard still blocks direct and normalized TCP connections',()=>{
 if(!process.execArgv.includes('--import')) return;
 const socket=new Socket();
 try {assert.throws(()=>socket.connect({host:'127.0.0.1',port:9}),/TCP connections are blocked/);
 assert.throws(()=>socket.connect([{host:'127.0.0.1',port:9}]),/TCP connections are blocked/);}
 finally{socket.destroy();}
});
