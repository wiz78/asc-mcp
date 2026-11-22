import { annotatePolicies } from "./catalog-policy.mjs";
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Only --help and version are executed; this generator never authenticates.
const specPath = process.argv[2];
if (!specPath) throw Error('Usage: node scripts/generate-catalog.mjs /path/to/openapi.oas.json [output-directory]');
const output = resolve(process.argv[3] || 'catalog');
const raw = readFileSync(specPath);
const spec = JSON.parse(raw);
const run = args => execFileSync('asc', args, { encoding: 'utf8', maxBuffer: 8e6, env: { ...process.env, NO_COLOR: '1' } });
const version = run(['version']).trim().split(' ')[0];
const rootHelp = run(['--help']);
const slug = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const roots = [];
let category;
for (const line of rootHelp.split('\n')) {
  if (/^[A-Z &]+ COMMANDS$/.test(line)) category = slug(line.replace(/ COMMANDS$/, ''));
  const m = line.match(/^  ([a-z][a-z0-9-]*):\s+(.+)$/);
  if (m && category) roots.push({ path: m[1], category, description: m[2] });
}
const commands = [];
for (let i = 0; i < roots.length; i++) {
  const entry = roots[i];
  const help = run([...entry.path.split(' '), '--help']);
  const section = help.match(/\nSUBCOMMANDS\n([\s\S]*?)(?=\n[A-Z][A-Z &]+\n|$)/)?.[1] || '';
  const children = [...section.matchAll(/^  ([a-z][a-z0-9-]*)\s{2,}(.+)$/gm)];
  commands.push({ ...entry, kind: children.length ? 'group' : 'leaf', exposure: 'unsupported', coverage: 'unsupported', reason: 'CLI semantics are not replicated by schema-backed endpoint tools.', apiOperations: [] });
  for (const m of children) roots.push({ path: `${entry.path} ${m[1]}`, category: entry.category, description: m[2] });
}
const mappings = [
 ['endAppAvailabilityPreOrders','pre-orders'], ['preReleaseVersions','testflight pre-release'], ['promotedPurchases','iap promoted-purchases'], ['retentionMessage','subscriptions retention-messages'], ['retentionOffers','subscriptions offers retention'], ['winBackOffers','subscriptions offers win-back'], ['scm','xcode-cloud scm'], ['diagnosticSignatures','performance diagnostics'], ['accessibility','accessibility'], ['actors','actors'], ['ageRating','age-rating'], ['alternativeDistribution','alternative-distribution'], ['androidToIos','android-ios-mapping'], ['appClip','app-clips'], ['appCustomProductPage','product-pages'], ['appStoreVersionExperiment','product-pages'], ['appEncryption','encryption'], ['appEvent','app-events'], ['appInfoLocalization','localizations'], ['appStoreReview','review'], ['appInfo','apps'], ['appScreenshot','screenshots'], ['appPreview','video-previews'], ['appAvailability','pricing availability'], ['territoryAvailability','pricing availability'], ['appPrice','pricing'], ['appPreOrder','pre-orders'], ['appStoreVersionLocalization','localizations'], ['appStoreVersionPhasedRelease','versions'], ['appStoreVersion','versions'], ['appCategory','categories'], ['appTag','app-tags'], ['appDataUsage','apps'], ['app','apps'], ['backgroundAsset','background-assets'], ['beta','testflight'], ['buildBundle','build-bundles'], ['buildBeta','testflight'], ['buildUpload','builds'], ['build','builds'], ['bundleId','bundle-ids'], ['certificate','certificates'], ['ci','xcode-cloud'], ['customerReview','reviews'], ['device','devices'], ['endUserLicense','eula'], ['finance','finance'], ['gameCenter','game-center'], ['inAppPurchase','iap'], ['marketplace','marketplace'], ['merchantId','merchant-ids'], ['nomination','nominations'], ['passTypeId','pass-type-ids'], ['perfPower','performance'], ['profile','profiles'], ['reviewSubmission','review'], ['routingAppCoverage','routing-coverage'], ['sandboxTester','sandbox'], ['subscription','subscriptions'], ['territor','pricing territories'], ['userInvitation','users'], ['user','users'], ['webhook','webhooks'], ['analyticsReport','analytics'], ['salesReport','analytics']
];
const reference = /^(territories|appCategories)$/;
const team = /^(actors|users|userInvitations|devices|bundleIds|certificates|profiles|merchantIds|passTypeIds|webhooks|ci)/;
const operations = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get','post','patch','put','delete','head','options'].includes(method)) continue;
    const resourceType = path.split('/')[2];
    const prefix = mappings.find(([start]) => resourceType.startsWith(start))?.[1];
    const base = prefix && commands.find(c => c.path === prefix);
    const action = method === 'get' ? (path.endsWith('{id}') ? 'get' : 'list') : ({ post:'create', patch:'update', put:'update', delete:'delete' })[method];
    const tail = path.split('/').filter(Boolean).at(-1);
    const desired = [tail && !tail.startsWith('{') && tail !== resourceType ? slug(tail.replace(/([a-z])([A-Z])/g,'$1-$2')) : '', action];
    const candidates = commands.filter(c => base && (c.path === prefix || c.path.startsWith(prefix + ' ')));
    const ranked = candidates.map(c => ({ c, score: desired.reduce((n,t) => n + (t && c.path.split(' ').includes(t) ? 2 : 0),0) + (c.kind === 'leaf' ? 0.1 : 0) })).sort((a,b)=>b.score-a.score);
    const command = ranked[0]?.score >= 2 ? ranked[0].c.path : base?.path || `api ${resourceType}`;
    const id = op.operationId || `${method}_${path}`;
    const safe = id.replace(/[^A-Za-z0-9_]/g,'_');
    const name = `api_${safe}`.length <= 64 ? `api_${safe}` : `api_${safe.slice(0,47)}_${createHash('sha256').update(id).digest('hex').slice(0,12)}`;
    const responses = Object.entries(op.responses || {}).filter(([code])=>/^2/.test(code));
    const responseSchema = responses.map(([,r])=>r.content?.['application/json']?.schema).find(Boolean) || null;
    const entry = { name, operationId:id, method:method.toUpperCase(), path, category:base?.category || 'utility', command, description:op.summary || op.description || `${method.toUpperCase()} ${path}`, parameters:[...(item.parameters || []),...(op.parameters || [])], requestBody:op.requestBody?.content?.['application/json']?.schema || null, requestBodyRequired:op.requestBody?.required || false, responseSchema, resourceType, scope:reference.test(resourceType) ? 'reference' : team.test(resourceType) ? 'team' : 'app', mapping:base ? 'inferred-resource-family' : 'unmapped', ownership:{ status:'requires-runtime-verification', resource:resourceType } };
    operations.push(entry);
    for (const c of candidates) c.apiOperations.push(name);
  }
}
const credential = /^(auth|doctor)( |$)|^web auth( |$)|^storekit auth( |$)|^ads auth( |$)/;
const external = /^(ads|storekit|web|notarization|notify|system-status)( |$)/;
const local = /^(xcode|ipa-info|pkg-info|init|install-skills|docs|search|schema|capabilities|version|completion|telemetry|migrate|diff|snitch)( |$)/;
for (const c of commands) {
  if (credential.test(c.path) || /(?:^| )(token|export-to-config|login|logout|issuer-id)(?: |$)/.test(c.path)) { c.exposure='credential'; c.reason='Credential and token operations are unavailable.'; c.apiOperations=[]; }
  else if (external.test(c.path)) { c.exposure='external'; c.reason='Uses a separate API, web session, or external service.'; c.apiOperations=[]; }
  else if (local.test(c.path)) { c.exposure='local'; c.reason='Local CLI behavior is not reproduced by endpoint tools.'; c.apiOperations=[]; }
  else if (c.apiOperations.length) { c.exposure='api'; c.coverage='partial'; c.reason='Related public API operations are available; CLI workflows, flags, aggregation, uploads and local behavior may differ.'; }
}
annotatePolicies(operations, spec.components.schemas, commands);
mkdirSync(output,{recursive:true});
const source = { url:'https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip', title:spec.info.title, apiVersion:spec.info.version, sha256:createHash('sha256').update(raw).digest('hex'), generatedBy:'scripts/generate-catalog.mjs', cliVersion:version, inventoryMethod:'Recursive asc --help only; no authenticated requests', mappingMethod:'Explicit resource-family mapping and command-name inference; partial semantic coverage only' };
writeFileSync(`${output}/api.json`, JSON.stringify({version:1,source,operations,schemas:spec.components.schemas}));
writeFileSync(`${output}/cli.json`, JSON.stringify({version:1,source:{cliVersion:version,inventoryMethod:source.inventoryMethod},commands}));
console.log(JSON.stringify({operations:operations.length,schemas:Object.keys(spec.components.schemas).length,commands:commands.length,categories:[...new Set(commands.map(c=>c.category))]}));
