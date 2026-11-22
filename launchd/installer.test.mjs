import test from 'node:test';
import assert from 'node:assert/strict';
import {installPlan, uninstallPlan, BASE} from './install-plan.mjs';
test('fresh install requires explicit creation consent',()=>{
 assert.throws(()=>installPlan({client:'tester',userExists:false}),/--create-service-user/);
 const m=installPlan({client:'tester',userExists:false,groupExists:false,memberExists:false,createUser:true});
 assert.deepEqual(uninstallPlan(m).slice(3),[['removeMembership','tester','ascclients'],['deleteGroup','ascclients'],['deleteUser','ascdaemon']]);
});
test('uninstall preserves preexisting accounts and membership',()=>{
 const m=installPlan({client:'tester',userExists:true,groupExists:true,memberExists:true});
 assert.deepEqual(uninstallPlan(m),[['bootout','system/local.asc-scoped'],['remove','/Library/LaunchDaemons/local.asc-scoped.plist'],['remove',BASE]]);
});
test('remove only membership added by installer',()=>{
 const m=installPlan({client:'tester',userExists:true,groupExists:true,memberExists:false});
 assert.deepEqual(uninstallPlan(m).at(-1),['removeMembership','tester','ascclients']);assert.equal(uninstallPlan(m).length,4);
});
test('existing secure token must be disabled',()=>{
 for(const secureToken of ['ENABLED','unknown','']) assert.throws(()=>installPlan({client:'tester',userExists:true,secureToken}),/Secure Token DISABLED/);
});
test('invalid manifest cannot redirect deletions',()=>{
 const m=installPlan({client:'tester',userExists:true,groupExists:true,memberExists:true});
 for(const patch of [{base:'/'},{user:'root'},{group:'admin'},{client:'root'},{createdUser:'false'},{version:2},{plist:'/etc/hosts'}]) assert.throws(()=>uninstallPlan({...m,...patch}),/Invalid installation manifest/);
});

import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const manifestHelper=fileURLToPath(new URL('./manifest-utils.sh',import.meta.url));
function nativeValidate(manifest){
 const directory=mkdtempSync(join(tmpdir(),'asc-manifest-test-'));
 try{
  const path=join(directory,'manifest.json');writeFileSync(path,JSON.stringify(manifest));
  // Arguments are passed as positional parameters, never interpolated into shell code.
  return spawnSync('/bin/bash',['-c','source "$1"; manifest_validate "$2"','manifest-test',manifestHelper,path],{encoding:'utf8'}).status;
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('standalone system parser accepts installation manifest without Node runtime',{skip:process.platform!=='darwin'},()=>{
 const m=installPlan({client:'tester',userExists:true,groupExists:true,memberExists:true});
 assert.equal(nativeValidate(m),0);
});
test('standalone parser rejects string booleans, missing fields and redirected paths',{skip:process.platform!=='darwin'},()=>{
 const m=installPlan({client:'tester',userExists:true,groupExists:true,memberExists:true});
 for(const patch of [{createdUser:'true'},{addedMembership:1},{createdGroup:null},{base:'/'},{client:'root'},{version:'1'}])assert.notEqual(nativeValidate({...m,...patch}),0,JSON.stringify(patch));
 const missing={...m};delete missing.createdUser;assert.notEqual(nativeValidate(missing),0);
});

test('client account names must be strings in plans and manifests',()=>{
 const m=installPlan({client:'tester',userExists:true,groupExists:true,memberExists:true});
 for(const client of [123,['tester'],{toString:()=> 'tester'}]){
  assert.throws(()=>installPlan({client,userExists:true}),/normal local client/);
  assert.throws(()=>uninstallPlan({...m,client}),/Invalid installation manifest/);
 }
});

import {readFileSync, mkdirSync} from 'node:fs';
// Execute only a redirected temporary copy, with every privileged operation
// replaced by a shell function. No system account or launchd action is possible.
function repairFailure(failure, registered=true){
 const directory=mkdtempSync(join(tmpdir(),'asc-repair-test-'));
 try{
  const base=join(directory,'base');mkdirSync(join(base,'private'),{recursive:true});
  writeFileSync(join(base,'private','op'),'old binary');
  writeFileSync(join(base,'install-manifest.json'),'{}');
  writeFileSync(join(directory,'action-lock.sh'),'action_lock_acquire() { :; }; action_lock_release() { :; }\n');
  writeFileSync(join(directory,'stage-op.sh'),'#!/bin/bash\nprintf "new binary" > "$1"\n');
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const log=join(directory,'calls');
  const mocks=`
chown() { :; }
launchctl() {
 printf '%s\\n' "$*" >> ${quote(log)}
 case "$1" in
  print) [[ ${registered?1:0} == 1 ]];;
  bootstrap) if [[ ${quote(failure)} == bootstrap && ! -e ${quote(join(directory,'failed'))} ]]; then touch ${quote(join(directory,'failed'))}; return 1; fi;;
 esac
}
cp() { [[ ${quote(failure)} != copy ]] || return 1; command cp "$@"; }
mv() { if [[ ${quote(failure)} == move && "$2" == */.op-repair.*/op ]]; then return 1; fi; command mv "$@"; }
`;
  let source=readFileSync(new URL('./repair-op.sh',import.meta.url),'utf8');
  source=source.replace("base='/Library/Application Support/ASCScoped'",`base=${quote(base)}`)
   .replace(/^source_dir=.*$/m,`source_dir=${quote(directory)}`)
   .replace('[[ $EUID == 0 && -d "$base/private" && -f "$base/install-manifest.json" ]]','[[ -d "$base/private" && -f "$base/install-manifest.json" ]]')
   .replace('umask 077','umask 077\n'+mocks);
  const script=join(directory,'repair.sh');writeFileSync(script,source);
  const result=spawnSync('/bin/bash',[script,'unused'],{encoding:'utf8'});
  return {status:result.status,binary:readFileSync(join(base,'private','op'),'utf8'),calls:readFileSync(log,{encoding:'utf8',flag:'a+'})};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('repair backup failure leaves existing daemon untouched',()=>{
 const r=repairFailure('copy');assert.notEqual(r.status,0);assert.equal(r.binary,'old binary');assert.equal(r.calls,'');
});
test('repair replacement failure restores daemon registration',()=>{
 const r=repairFailure('move');assert.notEqual(r.status,0);assert.equal(r.binary,'old binary');assert.match(r.calls,/bootout system\/local.asc-scoped/);assert.match(r.calls,/bootstrap system/);
});
test('repair bootstrap failure restores previous binary and registration',()=>{
 const r=repairFailure('bootstrap');assert.notEqual(r.status,0);assert.equal(r.binary,'old binary');assert.equal(r.calls.match(/bootstrap system/g)?.length,2);
});
test('repair failure preserves unregistered state',()=>{
 const r=repairFailure('bootstrap',false);assert.notEqual(r.status,0);assert.equal(r.binary,'old binary');assert.equal(r.calls.match(/bootstrap system/g)?.length,1);
});

function serviceAccountCheck({shell='/usr/bin/false',hidden='1',hiddenKey='IsHidden',token='DISABLED',admin=false,authority=';DisabledUser;'}={}){
 const source=readFileSync(new URL('./manage.sh',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('validate_service_user() {'),source.indexOf('\nif [[ "$action" == update || "$action" == rollback ]]'));
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 const mocks=`
set -euo pipefail
fail() { echo "$*" >&2; exit 1; }
id() { if [[ "$1" == -Gn ]]; then echo ${quote(admin?'staff admin':'staff')}; fi; }
sysadminctl() { echo ${quote('Secure token is '+token+' for user ascdaemon')}; }
dscl() { case "$4" in
 UserShell) echo ${quote('UserShell: '+shell)};;
 IsHidden) echo ${quote(hiddenKey+': '+hidden)};;
 AuthenticationAuthority) echo ${quote('AuthenticationAuthority: '+authority)};;
 esac; }
`;
 return spawnSync('/bin/bash',['-c',mocks+'\n'+fn+'\nvalidate_service_user'],{encoding:'utf8'});
}
test('existing service account checks require non-login identity, no admin membership and disabled Secure Token',()=>{
 assert.equal(serviceAccountCheck().status,0);
 for(const patch of [{shell:'/bin/zsh'},{shell:'/usr/bin/false-extra'},{token:'ENABLED'},{token:'unknown'},{admin:true}]){
  assert.notEqual(serviceAccountCheck(patch).status,0,JSON.stringify(patch));
 }
});

import {symlinkSync,readlinkSync} from 'node:fs';
function rollbackFailure(failure,registered=true){
 const directory=mkdtempSync(join(tmpdir(),'asc-rollback-test-'));
 try{
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const base=join(directory,'base');mkdirSync(base);
  symlinkSync('releases/current',join(base,'current'));symlinkSync('releases/previous',join(base,'previous'));
  const registeredFile=join(directory,'registered');if(registered)writeFileSync(registeredFile,'');
  const log=join(directory,'calls');
  const source=readFileSync(new URL('./manage.sh',import.meta.url),'utf8');
  const start=source.indexOf(' rollback_stopped=false;');
  const block=source.slice(start,source.indexOf(" echo 'Restored previous code release.",start));
  const mocks=`
set -euo pipefail
base=${quote(base)}
plist=synthetic-plist
action_lock_release() { :; }
previous=releases/previous
current=releases/current
launchctl() {
 printf '%s\\n' "$*" >> ${quote(log)}
 case "$1" in
  print) [[ -e ${quote(registeredFile)} ]];;
  bootout) rm -f ${quote(registeredFile)};;
  bootstrap) if [[ ${quote(failure)} == bootstrap && ! -e ${quote(join(directory,'failed'))} ]]; then touch ${quote(join(directory,'failed'))}; return 1; fi; touch ${quote(registeredFile)};;
 esac
}
mv() {
 if [[ ${quote(failure)} == switch && "$3" == */current || ${quote(failure)} == previous && "$3" == */previous ]]; then
  if [[ ! -e ${quote(join(directory,'failed'))} ]]; then touch ${quote(join(directory,'failed'))}; return 1; fi
 fi
 command mv "$@"
}
`;
  const result=spawnSync('/bin/bash',['-c',mocks+'\n'+block],{encoding:'utf8'});
  return {status:result.status,current:readlinkSync(join(base,'current')),previous:readlinkSync(join(base,'previous')),registered:spawnSync('/bin/test',['-e',registeredFile]).status===0,calls:readFileSync(log,'utf8')};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('rollback restores original release and registration after switch, bootstrap or history failure',()=>{
 for(const failure of ['switch','bootstrap','previous']){
  const r=rollbackFailure(failure);assert.notEqual(r.status,0,failure);
  assert.equal(r.current,'releases/current',failure);assert.equal(r.previous,'releases/previous',failure);assert.equal(r.registered,true,failure);
 }
});
test('failed rollback preserves originally unregistered state',()=>{
 const r=rollbackFailure('previous',false);assert.notEqual(r.status,0);assert.equal(r.current,'releases/current');assert.equal(r.registered,false);
});

import {existsSync,realpathSync} from 'node:fs';
function journalFailure(flag,failure){
 const directory=mkdtempSync(join(tmpdir(),'asc-journal-test-'));
 try{
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const base=join(directory,'base');mkdirSync(base);
  const manifest=join(base,'install-manifest.json');
  writeFileSync(manifest,JSON.stringify(installPlan({client:'tester',userExists:true,groupExists:true,memberExists:true})));
  if(failure==='write')mkdirSync(manifest+'.next');
  const marker=join(directory,'resource'),log=join(directory,'calls');writeFileSync(log,'');
  const source=readFileSync(new URL('./manage.sh',import.meta.url),'utf8');
  const functions=source.slice(source.indexOf('manifest_field() {'),source.indexOf('\nif [[ "$action" == uninstall ]]; then remove_owned;'));
  const script=`
set -euo pipefail
base=${quote(base)}
manifest=${quote(manifest)}
plist=${quote(join(base,'plist'))}
node_path=${quote(process.execPath)}
validate_manifest() { :; }
launchctl() { return 1; }
dscl() {
 if [[ "$2" == -read ]]; then [[ -e ${quote(marker)} ]];
 elif [[ "$2" == -delete ]]; then echo delete >> ${quote(log)}; rm -f ${quote(marker)}; fi
}
dseditgroup() {
 if [[ "$2" == checkmember ]]; then [[ -e ${quote(marker)} ]];
 else echo delete >> ${quote(log)}; rm -f ${quote(marker)}; fi
}
${functions}
cleanup_test() { local status=$?; set +e; remove_owned; exit "$status"; }
trap cleanup_test EXIT
mutate() {
 "$node_path" -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]));if(m[process.argv[2]]!==true)process.exit(2)' "$manifest" ${quote(flag)}
 echo mutation >> ${quote(log)}
 ${failure==='partial'?'touch '+quote(marker):':'}
 return 1
}
journal_mutation ${quote(flag)} mutate
`;
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8'});
  return {status:result.status,calls:readFileSync(log,'utf8'),baseExists:existsSync(base),resourceExists:existsSync(marker)};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('failed atomic journal writes prevent all account and membership mutations',()=>{
 for(const flag of ['createdUser','createdGroup','addedMembership']){
  const r=journalFailure(flag,'write');assert.notEqual(r.status,0,flag);assert.equal(r.calls,'',flag);assert.equal(r.baseExists,false,flag);
 }
});
test('journaled mutations that fail before or after creating resources clean up idempotently',()=>{
 for(const flag of ['createdUser','createdGroup','addedMembership'])for(const failure of ['mutation','partial']){
  const r=journalFailure(flag,failure);assert.notEqual(r.status,0,flag);assert.equal(r.calls,failure==='partial'?'mutation\ndelete\n':'mutation\n',flag);assert.equal(r.baseExists,false,flag);assert.equal(r.resourceExists,false,flag);
 }
});

function actionLockScenario(scenario){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'asc-lock-test-')));
 try{
  const path=join(directory,'lock'),helper=join(directory,'action-lock.sh');
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  writeFileSync(helper,readFileSync(new URL('./action-lock.sh',import.meta.url),'utf8').replace("action_lock_path='/Library/Application Support/.asc-scoped-deploy.lock'",`action_lock_path=${quote(path)}`));
  const script=`
set -euo pipefail
# Only the temporary test directory is used; ownership metadata is mocked.
stat() { if [[ "$2" == %u ]]; then echo 0; else echo 755; fi; }
source ${quote(helper)}
trap action_lock_release EXIT
${scenario==='stale'?'mkdir '+quote(path):''}
action_lock_acquire
${scenario==='error'?'false':scenario==='concurrent'?`/bin/bash -c 'stat() { if [[ "$2" == %u ]]; then echo 0; else echo 755; fi; }; source "$1"; trap action_lock_release EXIT; action_lock_acquire' lock-test ${quote(helper)}`:':'}
`;
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8'});
  return {status:result.status,exists:existsSync(path),stderr:result.stderr};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('shared deployment lock releases on success or action failure and excludes concurrent actions',()=>{
 for(const scenario of ['success','error','concurrent']){
  const r=actionLockScenario(scenario);assert.equal(r.status===0,scenario==='success',scenario);assert.equal(r.exists,false,scenario);
  if(scenario==='concurrent')assert.match(r.stderr,/Verify no install\/update\/rollback\/repair\/uninstall is running/);
 }
});
test('a preexisting deployment lock is preserved with explicit stale recovery guidance',()=>{
 const r=actionLockScenario('stale');assert.notEqual(r.status,0);assert.equal(r.exists,true);assert.match(r.stderr,/manually removing this stale lock/);
});


test('Node preflight warns for untested versions, architecture and mutable installations',()=>{
 const source=readFileSync(new URL('./manage.sh',import.meta.url),'utf8');
 const start=source.indexOf('validate_node() {');
 assert.ok(start>=0,'Node preflight must be independently testable');
 const fn=source.slice(start,source.indexOf('\nvalidate_node\n',start));
 const directory=mkdtempSync(join(tmpdir(),'asc-node-preflight-'));
 try {
  const binary=join(directory,'node');
  for(const {version,arch,trusted,status,warning} of [
   {version:'24.19.0',arch:'arm64',trusted:true,status:0,warning:false},
   {version:'26.0.0',arch:'arm64',trusted:true,status:0,warning:true},
   {version:'22.0.0',arch:'x64',trusted:false,status:0,warning:true},
   {version:'unknown',arch:'unknown',trusted:false,status:1,warning:true}
  ]) {
   writeFileSync(binary,'#!/bin/sh\nprintf "%s\\n" "'+version+' '+arch+'"\nexit '+status+'\n',{mode:0o755});
   const script='set -euo pipefail\nfail(){ echo "$*" >&2; exit 1; }\nwarn(){ echo "Warning: $*" >&2; }\nresolve(){ printf "%s\\n" "$1"; }\ntrusted(){ '+(trusted?'return 0':'return 1')+'; }\nnode_path="$1"\n'+fn+'\nvalidate_node';
   const result=spawnSync('/bin/bash',['-c',script,'test',binary],{encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);
   assert.equal(result.stderr.includes('Warning:'),warning,result.stderr);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('existing service account visibility is a preference',()=>{
 for(const hidden of ['1','0','']) assert.equal(serviceAccountCheck({hidden}).status,0);
});

test('existing service account authentication settings are preserved',()=>{
 for(const authority of [';DisabledUser;',';ShadowHash;','']) assert.equal(serviceAccountCheck({authority}).status,0);
});


test('release link creation stays accessible under the installer private umask',{skip:process.platform!=='darwin'},()=>{
 const directory=mkdtempSync(join(tmpdir(),'asc-link-mode-'));
 try {
  const source=readFileSync(new URL('./manage.sh',import.meta.url),'utf8');
  const fn=source.split('\n').find(line=>line.startsWith('ln() {'));
  assert.ok(fn);
  const result=spawnSync('/bin/bash',['-c','umask 077\n'+fn+'\nln -s target "$1/link"\n/usr/bin/stat -f %Lp "$1/link"','test',directory],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'755');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
