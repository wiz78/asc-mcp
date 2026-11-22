import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePolicy } from "./asc-policy.mjs";
import { parseConfiguration } from "./asc-config.mjs";

const operations = [
  { name: "price", category: "app-management", command: "pricing current", mode: "read" },
  { name: "availability", category: "app-management", command: "pricing availability view", mode: "read" },
  { name: "remove", category: "app-management", command: "pricing availability remove-from-sale", mode: "write" },
  { name: "users", category: "team-access", command: "users list", mode: "read" }
];
test("compact selectors use category/group subtrees and deny always wins", () => {
  const policy = compilePolicy({ allow: ["app-management"], deny: ["pricing availability"] }, operations);
  assert.equal(policy(operations[0]).allowed, true);
  assert.equal(policy(operations[1]).allowed, false);
  assert.equal(policy(operations[2]).allowed, false);
  assert.equal(policy(operations[3]).allowed, false);
  const audit = compilePolicy({ allow: ["read:pricing"] }, operations);
  assert.equal(audit(operations[1]).allowed, true);
  assert.equal(audit(operations[2]).allowed, false);
  const global = compilePolicy({ allow: ["read:*"], deny: ["app-management/pricing/availability/**"] }, operations);
  assert.equal(global(operations[3]).allowed, true);
  assert.equal(global(operations[1]).allowed, false);
  assert.equal(compilePolicy({ allow: [] }, operations)(operations[0]).allowed, false);
});
test("invalid selectors and config fail closed; team access is explicit", () => {
  assert.throws(() => compilePolicy({ allow: ["princing"] }, operations), /Unknown policy selector/);
  assert.throws(() => compilePolicy({ allow: ["execute:*"] }, operations), /read:/);
  assert.throws(() => compilePolicy({ allow: ["pricing *"] }, operations), /Invalid policy selector/);
  assert.throws(() => parseConfiguration({ apps: { test: { id: "123", policy: "missing" } } }), /defined/);
  assert.throws(() => parseConfiguration({ apps: {}, team: { enabled: true } }), /team/);
  assert.equal(parseConfiguration({ apps: { test: "123" } }).legacy, true);
  assert.equal(parseConfiguration({ apps: { test: { id: "123", policy: "audit" } }, policies: { audit: { allow: ["read:*"] } } }).team?.enabled, undefined);
});

test("legacy bare allowlists normalize and inherited property names cannot select missing policies", () => {
  assert.equal(parseConfiguration({ fixture: "123" }).appIds.fixture, "123");
  assert.throws(() => parseConfiguration({
    apps: { fixture: { id: "123", policy: "constructor" } }, policies: {}
  }), /defined/);
});

test("deny rules cannot silently match only an unmapped CLI inventory entry", () => {
  const known = [
    ...operations,
    { category: "monetization", command: "subscriptions groups", mode: "read" }
  ];
  assert.throws(() => compilePolicy({ allow: ["*"], deny: ["subscriptions groups"] }, known), /no executable operation mapping/);
});
