#!/usr/bin/env node
/**
 * Offline check for both halves of the plugin — no Desktop restart required.
 *
 * Covers:
 *   1. registration: the `dsh_web` tool and the six panel routes;
 *   2. the request fence (Desktop proxy, same-origin, hostile origins/hosts);
 *   3. the process-identity matcher that authorises a takeover;
 *   4. start failures that must surface fast (missing profile, missing binary);
 *   5. i18n parity: every panel key exists in both languages, and the dictionary
 *      is used through the locale service in one atomic call;
 *   6. read-only status/logs against the live `dsh web` port.
 *
 * Usage: node scripts/verify.mjs
 * Exit code 0 = all checks passed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply, looksLikeDshWeb, parseAccessUrls, defaultConfig } from '../index.js';

const results = [];
const check = (name, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, actual, expected, pass });
  return pass;
};
const note = (text) => results.push({ note: text });

// ---------------------------------------------------------------------------
// a fake cordis context, enough for both plugin instances
// ---------------------------------------------------------------------------

function instanceWith(config) {
  const tools = [];
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; } };
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (_deps, cb) => cb({ get: (name) => (name === 'webServer' ? webServer : undefined), webServer }),
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
  };
  apply(ctx, config);
  return { tools, routes, tool: tools.find((t) => t.name === 'dsh_web') };
}

const makeCtx = () => instanceWith({});

// ---------------------------------------------------------------------------
// 1. registration
// ---------------------------------------------------------------------------

const live = makeCtx();
check('tool registered', live.tool !== undefined, true);
check('tool actions', [...(live.tool?.parameters?.properties?.action?.enum ?? [])], ['status', 'start', 'stop', 'restart', 'logs']);
check('route count', live.routes.length, 6);
check('route paths', live.routes.map((r) => r.path).sort(), [
  '/dsh-web-manager/api/health',
  '/dsh-web-manager/api/logs',
  '/dsh-web-manager/api/restart',
  '/dsh-web-manager/api/start',
  '/dsh-web-manager/api/status',
  '/dsh-web-manager/api/stop',
]);

// ---------------------------------------------------------------------------
// 2. the request fence
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: null, body: '', writableEnded: false,
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

async function call(routes, routePath, { method = 'GET', headers = {}, socket = { remoteAddress: '127.0.0.1' } } = {}) {
  const route = routes.find((r) => r.path === routePath);
  if (!route) throw new Error(`no route for ${routePath}`);
  const req = { method, url: routePath, headers: { host: '127.0.0.1:43129', ...headers }, socket };
  const res = fakeRes();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.body, json: () => JSON.parse(res.body) };
}

const health = '/dsh-web-manager/api/health';
check('GET health', (await call(live.routes, health)).status, 200);
check('POST no origin (Desktop proxy)', (await call(live.routes, health, { method: 'POST' })).status, 200);
check('POST shell origin', (await call(live.routes, health, { method: 'POST', headers: { origin: 'dsh-desktop://harness' } })).status, 200);
check('POST same origin', (await call(live.routes, health, { method: 'POST', headers: { origin: 'http://127.0.0.1:43129' } })).status, 200);
check('POST evil origin', (await call(live.routes, health, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
check('POST null origin', (await call(live.routes, health, { method: 'POST', headers: { origin: 'null' } })).status, 403);
check('POST non-loopback', (await call(live.routes, health, { method: 'POST', socket: { remoteAddress: '10.0.0.9' } })).status, 403);
check('POST evil host', (await call(live.routes, health, { method: 'POST', headers: { host: 'evil.example' } })).status, 403);

// ---------------------------------------------------------------------------
// 3. process identity: accept the real boot lines, reject the neighbours
// ---------------------------------------------------------------------------

const accept = [
  ['dsh web', 'bare dsh'],
  ['/opt/homebrew/bin/node /opt/homebrew/bin/dsh web --no-open', 'homebrew boot'],
  ['node /usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js web --no-open', 'js entry'],
  ['node /x/dsh.js --verbose web', 'flag before subcommand'],
  ['"/opt/homebrew/bin/node" "/x/dsh" "web"', 'quoted argv'],
];
for (const [cmd, label] of accept) check(`matcher accepts ${label}`, looksLikeDshWeb(cmd), true);

const reject = [
  ['', 'empty'],
  ['node /x/dsh-desktop.js --profile web', 'dsh-desktop'],
  ['node /x/dsh-web-manager.js start web', 'dsh-web-manager'],
  ['node /x/dsh.js serve --name web', 'web as a flag value'],
  ['/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop', 'the Desktop app itself'],
];
for (const [cmd, label] of reject) check(`matcher rejects ${label}`, looksLikeDshWeb(cmd), false);

// ---------------------------------------------------------------------------
// 3b. access URL parsing: only this target's tokens, newest first
// ---------------------------------------------------------------------------

const urlCfg = { host: '127.0.0.1', port: 3080 };
const urlText = [
  'starting',
  'dsh web: http://127.0.0.1:3080/?token=old-token',
  'noise between boots',
  'dsh web: http://127.0.0.1:3080/?token=new-token',
  'dsh web: http://127.0.0.1:3099/?token=other-port',
  'dsh web: http://10.0.0.5:3080/?token=remote-host',
  'dsh web: https://localhost:3080/?token=localhost-token',
].join('\n');
check('parseAccessUrls filters port/host and prefers the newest', parseAccessUrls(urlText, urlCfg), [
  'https://localhost:3080/?token=localhost-token',
  'http://127.0.0.1:3080/?token=new-token',
  'http://127.0.0.1:3080/?token=old-token',
]);
check('parseAccessUrls strips log punctuation',
  parseAccessUrls('see http://127.0.0.1:3080/?token=abc123).', urlCfg),
  ['http://127.0.0.1:3080/?token=abc123']);
check('parseAccessUrls ignores text without tokens', parseAccessUrls('no url here', urlCfg), []);
check('entry file defaults under the dsh run dir',
  defaultConfig({ port: 3999 }).entryFile,
  path.join(os.homedir(), '.dsh/run/dsh-web-manager-3999.entry.json'));
check('entry file can be overridden',
  defaultConfig({ port: 3999, entryFile: '~/custom.entry.json' }).entryFile,
  path.join(os.homedir(), 'custom.entry.json'));

// ---------------------------------------------------------------------------
// 4. start failures must be reported quickly, not as a readiness timeout
// ---------------------------------------------------------------------------

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-web-manager-verify-'));
try {
  // A fresh instance with its own config, on a port nothing listens on.
  const badCtx = instanceWith({
    port: 45999,
    profileDir: tmp,
    logFile: path.join(tmp, 'logs', 'missing-binary.log'),
    pidFile: path.join(tmp, 'run', 'missing-binary.pid'),
    command: ['/nonexistent/dsh-binary-for-verify', 'web'],
  });
  const startedAt = Date.now();
  const failed = JSON.parse(await badCtx.tool.execute({ action: 'start', waitSeconds: 5 }, {}));
  const elapsed = Date.now() - startedAt;
  check('missing binary reports spawn-failed', failed.reason, 'spawn-failed');
  check('missing binary fails fast (<4s, not the 5s window)', elapsed < 4000, true);
  check('missing binary leaves no pid record', fs.existsSync(path.join(tmp, 'run', 'missing-binary.pid')), false);
  note(`missing binary reported after ${elapsed}ms: ${String(failed.detail ?? '').slice(0, 80)}`);

  const failedStatus = JSON.parse(await badCtx.tool.execute({ action: 'status' }, {}));
  check('failed start is exposed as a tri-state', failedStatus.state, 'failed');
  check('failed start carries its reason', failedStatus.failure?.reason, 'spawn-failed');
  const dismissed = JSON.parse(await badCtx.tool.execute({ action: 'stop' }, {}));
  check('stop dismisses the failed state', dismissed.status?.state, 'stopped');
  check('stop clears the failure record', dismissed.status?.failure, null);

  const goneProfile = instanceWith({
    port: 45998,
    profileDir: path.join(tmp, 'no-such-profile'),
    logFile: path.join(tmp, 'logs', 'no-profile.log'),
    pidFile: path.join(tmp, 'run', 'no-profile.pid'),
  });
  const noProfile = JSON.parse(await goneProfile.tool.execute({ action: 'start', waitSeconds: 5 }, {}));
  check('missing profile reports profile-missing', noProfile.reason, 'profile-missing');
  check('missing profile is not created', fs.existsSync(path.join(tmp, 'no-such-profile')), false);
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 4b. the entry URL is recovered, verified and remembered
// ---------------------------------------------------------------------------

const entryTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-web-entry-verify-'));
const fake = { token: 'token-one' };
const fakeServer = http.createServer((req, res) => {
  const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (parsed.pathname === '/' && parsed.searchParams.get('token') === fake.token) {
    res.writeHead(303, { location: './' });
  } else {
    res.writeHead(401);
  }
  res.end();
});
await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
const fakePort = fakeServer.address().port;
const stopFakeServer = () => new Promise((resolve) => {
  fakeServer.close(() => resolve());
  fakeServer.closeAllConnections?.();
});
try {
  const logFile = path.join(entryTmp, 'web.log');
  const entryFile = path.join(entryTmp, 'entry.json');
  const ctx = instanceWith({
    port: fakePort,
    profileDir: entryTmp,
    logFile,
    pidFile: path.join(entryTmp, 'web.pid'),
    entryFile,
  });
  const url1 = `http://127.0.0.1:${fakePort}/?token=${fake.token}`;
  // The boot line sits far beyond any 300-line tail, the shape of the real log.
  const bootLog = [`dsh web: ${url1}`];
  for (let i = 0; i < 1500; i++) bootLog.push(`noise ${i}`);
  await fsp.writeFile(logFile, `${bootLog.join('\n')}\n`);

  let st = (await call(ctx.routes, '/dsh-web-manager/api/status')).json();
  check('status recovers a URL beyond the old 300-line tail', st.readyUrl, url1);
  check('recovered URL is verified against the live server', st.readyUrlLive, true);
  check('verified URL is persisted to the entry file', JSON.parse(await fsp.readFile(entryFile, 'utf8')).url, url1);

  await fsp.writeFile(logFile, 'log rotated, token line gone\n');
  st = (await call(ctx.routes, '/dsh-web-manager/api/status')).json();
  check('entry file keeps the URL when the log rotates', st.readyUrl, url1);
  check('remembered URL is still verified', st.readyUrlLive, true);

  fake.token = 'token-two';
  const url2 = `http://127.0.0.1:${fakePort}/?token=${fake.token}`;
  await fsp.writeFile(logFile, `dsh web: ${url2}\n`);
  st = (await call(ctx.routes, '/dsh-web-manager/api/status')).json();
  check('a restarted server replaces the remembered URL', st.readyUrl, url2);
  check('the replacement URL is verified live', st.readyUrlLive, true);
  check('entry file follows the new token', JSON.parse(await fsp.readFile(entryFile, 'utf8')).url, url2);

  await stopFakeServer();
  st = (await call(ctx.routes, '/dsh-web-manager/api/status')).json();
  check('stopped status keeps the last known URL', st.readyUrl, url2);
  check('stopped status marks the remembered URL as not live', st.readyUrlLive, false);
} finally {
  if (fakeServer.listening) await stopFakeServer();
  await fsp.rm(entryTmp, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 5. i18n parity between the two halves of the panel copy
// ---------------------------------------------------------------------------

/** Pull one object literal out of the Client source, skipping quoted strings. */
function objectLiteralAfter(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(src.indexOf('{', start), i + 1);
  }
  return null;
}

const clientSrc = await fsp.readFile(new URL('../client.js', import.meta.url), 'utf8');
const dictSource = objectLiteralAfter(clientSrc, 'const DICT = ');
check('client dictionary is extractable', typeof dictSource, 'string');
const DICT = dictSource ? new Function(`return (${dictSource});`)() : { en: {}, zh: {} };

const enKeys = Object.keys(DICT.en ?? {}).sort();
const zhKeys = Object.keys(DICT.zh ?? {}).sort();
check('en/zh dictionaries have identical keys', enKeys, zhKeys);
check('every panel string is non-empty', enKeys.every((k) => typeof DICT.en[k] === 'string' && DICT.en[k].length > 0 && typeof DICT.zh[k] === 'string' && DICT.zh[k].length > 0), true);

const usedKeys = new Set();
for (const match of clientSrc.matchAll(/\bt\('([^']+)'\)/g)) usedKeys.add(match[1]);
const missingKeys = [...usedKeys].filter((key) => !(key in (DICT.en ?? {})) || !(key in (DICT.zh ?? {})));
check('every t() key exists in both languages', missingKeys, []);
check('dynamic phase keys exist', Object.keys(DICT.en ?? {}).filter((k) => k.startsWith('phase.')).length, 7);
check('client paints three distinct state colors', ['run', 'fail', 'stop'].every((tone) => clientSrc.includes(`.dswm-phase.${tone}`)), true);
check('sidebar icon is tinted by state', clientSrc.includes('TONE_COLOR[tone]'), true);
check('panel keeps an always-visible entry card', clientSrc.includes('dswm-entry-url'), true);
check('entry card offers copy and open actions', clientSrc.includes('copyToClipboard') && clientSrc.includes("t('entry.open')"), true);
check('entry card distinguishes live / pending / offline', ['live', 'pending', 'offline'].every((kind) => clientSrc.includes(`.dswm-entry-badge.${kind}`)), true);
check('locale registration is one atomic call', /locale\.register\('dshWebManager', \{ en: DICT\.en, zh: DICT\.zh \}\)/.test(clientSrc), true);

for (const [id, label] of [['en', 'english'], ['zh', 'chinese']]) {
  const meta = JSON.parse(await fsp.readFile(new URL(`../locale/${id}.json`, import.meta.url), 'utf8'));
  check(`locale/${id}.json meta title (${label})`, typeof meta?.meta?.title === 'string' && meta.meta.title.length > 0, true);
  check(`locale/${id}.json meta description (${label})`, typeof meta?.meta?.description === 'string' && meta.meta.description.length > 0, true);
}

// ---------------------------------------------------------------------------
// 6. read-only status/logs against the live target
// ---------------------------------------------------------------------------

const statusRes = await call(live.routes, '/dsh-web-manager/api/status');
check('GET status', statusRes.status, 200);
const status = statusRes.json();
check('status has a boolean listening flag', typeof status.listening, 'boolean');
check('status lists degraded capabilities', Array.isArray(status.degraded), true);
check('status exposes a panel state', ['running', 'stopped', 'failed', 'foreign'].includes(status.state), true);
const logs = JSON.parse(await live.tool.execute({ action: 'logs', lines: 5 }, {}));
check('logs readable', logs.exists, true);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

for (const result of results) {
  if (result.note !== undefined) {
    console.log(`  ·  ${result.note}`);
    continue;
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}  (got ${JSON.stringify(result.actual)})`);
}
const checks = results.filter((r) => r.note === undefined);
const failed = checks.filter((r) => !r.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
console.log(
  `dsh web target ${status.target.host}:${status.target.port} — ${status.listening ? (status.foreign ? 'external listener' : 'running') : 'stopped'}`
  + `${status.managed ? `, managed pid ${status.managed.pid}` : ''}`
  + `${status.readyUrl ? `, ${status.readyUrl}` : ''}`,
);
if (status.degraded?.length) console.log(`degraded: ${status.degraded.join(', ')}`);
process.exit(failed === 0 ? 0 : 1);
