import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = JSON.parse(readFileSync(new URL('./catalog/api.json', import.meta.url)));
const cli = JSON.parse(readFileSync(new URL('./catalog/cli.json', import.meta.url)));
test('pinned account-free public API and CLI catalogues are substantial', () => {
  assert.equal(api.source.apiVersion, '4.6.1');
  assert.equal(api.source.cliVersion, '6.6.1');
  assert.match(api.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(api.operations.length, 1342);
  assert.equal(cli.commands.length, 1994);
  assert.equal(Object.keys(api.schemas).length, 1517);
  assert.equal(new Set(api.operations.map(o => o.name)).size, api.operations.length);
  assert.equal(new Set(cli.commands.map(c => c.path)).size, cli.commands.length);
  assert.ok(cli.commands.some(c=>c.path==='pricing availability view'));
  assert.ok(cli.commands.some(c=>c.path==='auth token'));
});
test('every endpoint has a bounded unique name, policy category and original schema', () => {
  const categories = new Set(cli.commands.map(c=>c.category));
  for (const op of api.operations) {
    assert.match(op.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(categories.has(op.category));
    assert.ok(op.command);
    assert.ok(['app','team','reference'].includes(op.scope));
    assert.ok(Array.isArray(op.parameters));
    assert.ok(['GET','POST','PATCH','DELETE','PUT','HEAD','OPTIONS'].includes(op.method));
  }
  const visit = value => {
    if (!value || typeof value!=='object') return;
    if (value.$ref) {
      assert.match(value.$ref,/^#\/components\/schemas\//);
      const key=value.$ref.slice('#/components/schemas/'.length).replace(/~1/g,'/').replace(/~0/g,'~');
      assert.ok(api.schemas[key], `Unresolved ${value.$ref}`);
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(api.operations); visit(api.schemas);
});
test('CLI inventory is explicit about exclusions and partial semantic coverage', () => {
  const names=new Set(api.operations.map(o=>o.name));
  for (const command of cli.commands) {
    assert.ok(['api','local','credential','external','unsupported'].includes(command.exposure));
    assert.ok(['partial','unsupported'].includes(command.coverage));
    assert.ok(command.reason);
    for (const name of command.apiOperations) assert.ok(names.has(name));
    if (command.exposure==='credential') assert.deepEqual(command.apiOperations,[]);
    if (/^auth(?: |$)/.test(command.path)) assert.equal(command.exposure,'credential');
    assert.notEqual(command.coverage,'full');
  }
});
