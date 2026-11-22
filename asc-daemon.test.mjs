import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperations } from "./asc-operations.mjs";

test("scoped lists establish ownership and edits use the cache", async () => {
  const requests = [];
  const request = async (path, options) => {
    requests.push([path, options?.method]);
    if (path.startsWith("/v1/apps/123/")) {
      return { data: [{ type: "appStoreVersions", id: "v1", attributes: {
        versionString: "1.0", arbitrary: { id: "foreign" }
      } }] };
    }
    return { data: [{ type: "appStoreVersionLocalizations", id: "l1", attributes: { locale: "en-US" } }] };
  };
  const call = createOperations({ cue: "123", other: "456" }, request);
  assert.deepEqual(await call("cue", "list_versions", {}), [{ id: "v1", versionString: "1.0" }]);
  await call("cue", "list_version_localizations", { version_id: "v1" });
  await call("cue", "update_version_localization", { localization_id: "l1", description: "Updated" });
  assert.deepEqual(requests, [
    ["/v1/apps/123/appStoreVersions?limit=200", undefined],
    ["/v1/appStoreVersions/v1/appStoreVersionLocalizations?limit=200", undefined],
    ["/v1/appStoreVersionLocalizations/l1", "PATCH"]
  ]);
});

test("rejects unknown aliases, wrong types and IDs nested outside data", async () => {
  const requests = [];
  const call = createOperations({ cue: "123", other: "456" }, async path => {
    requests.push(path);
    if (path.startsWith("/v1/apps/123/")) return {
      data: [{ type: "appStoreVersions", id: "v1" }],
      included: [{ type: "appStoreVersionLocalizations", id: "foreign" }]
    };
    return { data: [] };
  });
  await call("cue", "list_versions", {});
  await assert.rejects(call("constructor", "get_app", {}), /Unknown app/);
  await assert.rejects(call("cue", "asc_exec", { args: [] }), /Unknown operation/);
  await assert.rejects(call("other", "list_version_localizations", { version_id: "v1" }), /ownership/);
  await assert.rejects(call("cue", "update_version_localization", { localization_id: "v1", description: "x" }), /ownership/);
  await assert.rejects(call("cue", "update_version_localization", { localization_id: "foreign", description: "x" }), /ownership/);
  assert.equal(requests.some(path => path.startsWith("/v1/appStoreVersionLocalizations/")), false);
});

test("uses one coalesced Apple ownership check on a version cache miss", async () => {
  let now = 0;
  const requests = [];
  const call = createOperations({ cue: "123" }, async path => {
    requests.push(path);
    if (path.endsWith("?include=app")) return {
      data: { id: "v1", type: "appStoreVersions", relationships: {
        app: { data: { id: "123", type: "apps" } }
      } }
    };
    return { data: [] };
  }, { now: () => now });
  const list = () => call("cue", "list_version_localizations", { version_id: "v1" });
  await Promise.all([list(), list()]);
  assert.equal(requests.length, 2);
  await list();
  assert.equal(requests.length, 3);
  now = 600_001;
  await list();
  assert.equal(requests.length, 5);
});

test("rejects a pagination link that changes the app scope", async () => {
  const requests = [];
  const call = createOperations({ cue: "123" }, async path => {
    requests.push(path);
    return { data: [], links: { next: "/v1/apps/456/appStoreVersions?cursor=other" } };
  });
  await assert.rejects(call("cue", "list_versions", {}), /pagination/);
  assert.equal(requests.length, 1);
});


import {mkdtempSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('daemon starts its main entry point through a release symlink',()=>{
 const directory=mkdtempSync(join(tmpdir(),'asc-entry-'));
 try {
  symlinkSync(fileURLToPath(new URL('./',import.meta.url)),join(directory,'current'));
  const result=spawnSync(process.execPath,[join(directory,'current','asc-daemon.mjs'),join(directory,'missing.json')],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/ASC daemon setup failed/);
 } finally {rmSync(directory,{recursive:true,force:true});}
});


test('daemon and preview can be imported from a Node stdin script',()=>{
 for(const name of ['asc-daemon.mjs','asc-preview.mjs']) {
  const url=new URL(name,import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-'],{input:'await import('+JSON.stringify(url)+');',encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
 }
});
