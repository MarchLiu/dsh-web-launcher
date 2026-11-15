/**
 * Host half of @mars.liu/dsh-web-launcher.
 *
 * Manages the standalone CLI `dsh web` server (the one that serves the user's
 * own web GUI, e.g. http://127.0.0.1:3080 from ~/.dsh/profiles/web) as a
 * detached, isolated process:
 *   - spawned in its own session (setsid) so it survives this Desktop app
 *     quitting and the plugin reloading;
 *   - given a MINIMAL environment (HOME, PATH, DSH_HOME, LANG, SHELL, TERM) —
 *     never a copy of the Desktop harness environment, so none of DSH_PROFILE,
 *     DSH_SESSION_ID, DSH_WEB_URL, NODE_COMPILE_CACHE or the Desktop bin dir
 *     can leak into the web process;
 *   - stdout/stderr appended to the configured log file.
 *
 * Surfaces:
 *   - one agent tool `dsh_web` (status | start | stop | restart | logs);
 *   - same-origin, loopback-only JSON routes under /dsh-web-manager/api/* for
 *     the Client panel.
 *
 * Plain Node only: no @deepseek-ai imports, so this loads anywhere the loader
 * can load a plain-JS plugin.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'dsh-web-manager';
const ROUTE_ROOT = '/dsh-web-manager';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * True when the helper command itself could not run — a missing binary, a
 * denied exec (EPERM/EACCES from a sandbox), or a timeout — as opposed to
 * running fine and simply finding nothing (e.g. `ps -p` exit 1 for a dead pid).
 */
function execUnavailable(err) {
  if (!err) return false;
  return err.code === 'ENOENT'
    || err.code === 'EPERM'
    || err.code === 'EACCES'
    || Boolean(err.killed)
    || Boolean(err.signal);
}

/** Run one short helper command; never throws, resolves { err, stdout, stderr }. */
function sh(file, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const settle = (err, stdout, stderr) => resolve({
      err,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
    });
    try {
      execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, settle);
    } catch (err) {
      // execFile can throw synchronously when the spawn itself is denied
      // (EPERM under a file sandbox); report it through the same shape so no
      // caller has to guard against a rejection.
      settle(err);
    }
  });
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Best-effort `ps -p <pid> -o command=`.
 * `known: false` means ps itself could not run, so the command line is unknown
 * rather than empty — callers degrade instead of concluding "not ours".
 */
async function commandOfPid(pid) {
  const { err, stdout } = await sh('/bin/ps', ['-p', String(pid), '-o', 'command=']);
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return { command: line, known: !execUnavailable(err) };
}

/** argv[0] basenames that really are the `dsh` CLI entry (never dsh-desktop / dsh-*). */
const DSH_ENTRY = /^dsh(?:\.(?:c|m)?js)?$/i;

/**
 * Only a process whose argv really is a `dsh web` boot is ever signalled.
 *
 * Matches on the parsed argv rather than on a loose word pair: the entry token
 * must be `dsh` (or `dsh.js`/`dsh.cjs`/`dsh.mjs`), and its first non-flag
 * argument must be `web`. That still accepts the real boot lines
 * (`node …/bin/dsh web --no-open`, `node …/dsh.js --flag web`) while rejecting
 * neighbours such as `dsh-desktop … web` or `dsh-web-manager … web`. Failing
 * closed is deliberate: a false negative only refuses a takeover, a false
 * positive kills an unrelated process.
 */
function looksLikeDshWeb(cmd) {
  if (typeof cmd !== 'string' || cmd === '') return false;
  const argv = cmd.trim().split(/\s+/).map((token) => token.replace(/^["']+|["']+$/g, ''));
  for (let i = 0; i < argv.length - 1; i++) {
    if (!DSH_ENTRY.test(path.basename(argv[i]))) continue;
    for (let j = i + 1; j < argv.length; j++) {
      if (argv[j].startsWith('-')) continue; // global flags before the subcommand
      if (argv[j] === 'web') return true;
      break; // first non-flag argument is another subcommand
    }
  }
  return false;
}

async function lsofBinary() {
  for (const candidate of ['/usr/sbin/lsof', 'lsof']) {
    const probe = await sh(candidate, ['-v'], 5_000);
    if (!probe.err || probe.err.code !== 'ENOENT') return candidate;
  }
  return null;
}

async function listenerPidOf(port) {
  const bin = await lsofBinary();
  if (!bin) return null;
  const { stdout } = await sh(bin, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = Number.parseInt(stdout.trim().split('\n')[0], 10);
  return Number.isInteger(pid) ? pid : null;
}

function portProbe(cfg, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: cfg.host, port: cfg.port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function httpProbe(cfg, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: cfg.host, port: cfg.port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ listening: true, httpStatus: res.statusCode ?? null });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ listening: true, httpStatus: null });
    });
    request.on('error', () => resolve({ listening: false, httpStatus: null }));
    request.end();
  });
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export function defaultConfig(user = {}) {
  const dshHome = expandHome(typeof user.dshHome === 'string' && user.dshHome ? user.dshHome : '~/.dsh');
  const port = clampInt(user.port, 1, 65_535, 3080);
  const command = Array.isArray(user.command)
    && user.command.length > 0
    && user.command.every((part) => typeof part === 'string')
    ? user.command
    : ['/opt/homebrew/bin/node', '/opt/homebrew/bin/dsh', 'web', '--no-open'];
  return {
    name: typeof user.name === 'string' && user.name ? user.name : 'dsh web',
    port,
    host: typeof user.host === 'string' && user.host ? user.host : '127.0.0.1',
    dshHome,
    profileDir: expandHome(typeof user.profileDir === 'string' && user.profileDir ? user.profileDir : `${dshHome}/profiles/web`),
    logFile: expandHome(typeof user.logFile === 'string' && user.logFile ? user.logFile : `${dshHome}/logs/dsh-web-${port}.log`),
    pidFile: expandHome(typeof user.pidFile === 'string' && user.pidFile ? user.pidFile : `${dshHome}/run/dsh-web-manager-${port}.pid`),
    command,
    pathPrefix: typeof user.pathPrefix === 'string' && user.pathPrefix ? user.pathPrefix : '/opt/homebrew/bin',
    extraEnv: user.extraEnv && typeof user.extraEnv === 'object' && !Array.isArray(user.extraEnv) ? user.extraEnv : {},
    allowForeignTakeover: user.allowForeignTakeover !== false,
    readyTimeoutMs: clampInt(user.readyTimeoutMs, 5_000, 300_000, 90_000),
  };
}

/**
 * The isolated environment handed to the spawned web server. Built from
 * scratch — `process.env` is never spread — so nothing from the Desktop
 * harness (DSH_PROFILE, DSH_SESSION_ID, DSH_WEB_URL, DSH_SHELL, the
 * dsh-desktop bin dir on PATH, NODE_COMPILE_CACHE, ...) can leak in.
 */
function isolatedEnv(cfg) {
  const desktopFreePath = String(process.env.PATH ?? '')
    .split(':')
    .filter((segment) => segment
      && !/dsh[- ]?desktop/i.test(segment)
      && !/desktop\.app/i.test(segment))
    .join(':');
  const env = {
    HOME: os.homedir(),
    PATH: `${cfg.pathPrefix}:${desktopFreePath}`,
    DSH_HOME: cfg.dshHome,
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
  };
  for (const [key, value] of Object.entries(cfg.extraEnv)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// log + pidfile
// ---------------------------------------------------------------------------

async function appendMarker(cfg, text) {
  const line = `\n===== [${PLUGIN_ID}] ${text} at ${new Date().toISOString()} =====\n`;
  await fsp.mkdir(path.dirname(cfg.logFile), { recursive: true }).catch(() => {});
  await fsp.appendFile(cfg.logFile, line).catch(() => {});
}

async function tailLog(cfg, { lines = 200, grep } = {}) {
  const want = clampInt(lines, 1, 2000, 200);
  const result = { path: cfg.logFile, exists: false, size: 0, truncated: false, grep: grep || null, returned: 0, lines: [] };
  let stat;
  try {
    stat = await fsp.stat(cfg.logFile);
  } catch {
    return result;
  }
  result.exists = true;
  result.size = stat.size;
  const maxBytes = 1_000_000;
  const length = Math.min(stat.size, maxBytes);
  const start = stat.size - length;
  const handle = await fsp.open(cfg.logFile, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    result.truncated = stat.size > maxBytes;
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    let all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    if (grep) {
      const needle = String(grep).toLowerCase();
      all = all.filter((line) => line.toLowerCase().includes(needle));
    }
    const out = all.slice(-want);
    result.returned = out.length;
    result.lines = out;
    return result;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Newest `?token=…` access URL in the log, preferring the configured port. */
async function readyUrlFromLog(cfg) {
  const tail = await tailLog(cfg, { lines: 300 });
  const re = /https?:\/\/[^\s'"<>]+[?&]token=[A-Za-z0-9_-]+/g;
  const found = [];
  for (let i = tail.lines.length - 1; i >= 0 && found.length < 8; i--) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(tail.lines[i])) !== null) {
      try {
        const url = new URL(match[0]);
        if (url.searchParams.get('token')) found.push(match[0]);
      } catch { /* not a usable URL */ }
    }
  }
  const preferred = found.find((u) => new URL(u).port === String(cfg.port));
  return preferred ?? found[0] ?? null;
}

async function readPidFile(cfg) {
  try {
    const raw = await fsp.readFile(cfg.pidFile, 'utf8');
    const data = JSON.parse(raw);
    if (Number.isInteger(data?.pid)) return data;
  } catch { /* missing or corrupt */ }
  return null;
}

async function writePidFile(cfg, pid) {
  await fsp.mkdir(path.dirname(cfg.pidFile), { recursive: true });
  await fsp.writeFile(cfg.pidFile, `${JSON.stringify({ pid, startedAt: new Date().toISOString(), command: cfg.command })}\n`);
}

async function removePidFile(cfg) {
  await fsp.rm(cfg.pidFile, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// recent start outcome
// ---------------------------------------------------------------------------

/**
 * In-memory outcome of the last start attempt, keyed by target. It exists so
 * the panel can paint three distinct states — running / stopped / start
 * failed — instead of only "listening yes/no": a failed start leaves no
 * process behind, so without this record it would be indistinguishable from a
 * deliberate stop. Cleared as soon as the server is seen running or stopped.
 */
const startOutcomes = new Map();

function outcomeKey(cfg) {
  return `${cfg.host}:${cfg.port}`;
}

function outcomeOf(cfg) {
  const key = outcomeKey(cfg);
  let entry = startOutcomes.get(key);
  if (!entry) {
    entry = { lastStart: null };
    startOutcomes.set(key, entry);
  }
  return entry;
}

function clearStartOutcome(cfg) {
  outcomeOf(cfg).lastStart = null;
}

function recordStartOutcome(cfg, result) {
  const ok = result?.ready === true;
  const reason = result?.reason ?? (result?.exited ? 'exited' : ok ? 'ready' : 'unknown');
  outcomeOf(cfg).lastStart = {
    at: new Date().toISOString(),
    ok,
    action: result?.action ?? 'start',
    reason,
    detail: result?.detail ?? null,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
  };
}

/**
 * The single place that turns probe data + the last start outcome into the
 * panel's canonical state. Also drops a stale failure the first time the
 * server is observed listening, so an external boot supersedes it.
 */
function applyRuntimeState(cfg, status) {
  const listening = Boolean(status.listening);
  const entry = outcomeOf(cfg);
  if (listening && entry.lastStart && !entry.lastStart.ok) entry.lastStart = null;
  const failure = !listening
    ? (entry.lastStart && entry.lastStart.ok === false
      ? entry.lastStart
      : status.managed
        ? {
          at: null,
          ok: false,
          action: 'start',
          reason: 'exited',
          detail: null,
          exitCode: null,
        }
        : null)
    : null;
  return {
    ...status,
    state: listening ? (status.foreign ? 'foreign' : 'running') : failure ? 'failed' : 'stopped',
    failure,
    lastStart: entry.lastStart ?? null,
  };
}

// ---------------------------------------------------------------------------
// manager operations
// ---------------------------------------------------------------------------

async function statusOf(cfg) {
  const [probe, listenerPid, pidRecord] = await Promise.all([httpProbe(cfg), listenerPidOf(cfg.port), readPidFile(cfg)]);
  const degraded = [];
  let managed = null;
  if (pidRecord) {
    if (await processAlive(pidRecord.pid)) {
      const { command, known } = await commandOfPid(pidRecord.pid);
      if (!known) degraded.push('process-inspection');
      // Two independent ways to accept our own process, because only *foreign*
      // processes need the strict argv match:
      //   - ps is unavailable: the pidfile is our own claim and the pid is alive;
      //   - the pidfile's pid is the port's listener: this plugin spawned it,
      //     even if its argv is exotic enough for looksLikeDshWeb to decline.
      const ownsPort = listenerPid !== null && listenerPid === pidRecord.pid;
      if (!known || ownsPort || looksLikeDshWeb(command)) {
        managed = { pid: pidRecord.pid, startedAt: pidRecord.startedAt ?? null, command: pidRecord.command ?? cfg.command };
      }
    } else {
      await removePidFile(cfg); // stale record, the process is gone
    }
  }
  let listener = null;
  if (listenerPid) {
    const { command, known } = await commandOfPid(listenerPid);
    if (!known && !degraded.includes('process-inspection')) degraded.push('process-inspection');
    listener = { pid: listenerPid, command };
  }
  const foreign = Boolean(probe.listening && (!managed || (listener && listener.pid !== managed.pid)));
  const env = isolatedEnv(cfg);
  return applyRuntimeState(cfg, {
    ok: true,
    plugin: PLUGIN_ID,
    ts: new Date().toISOString(),
    target: {
      name: cfg.name,
      host: cfg.host,
      port: cfg.port,
      profileDir: cfg.profileDir,
      dshHome: cfg.dshHome,
      logFile: cfg.logFile,
      command: cfg.command,
    },
    listening: probe.listening,
    httpStatus: probe.httpStatus,
    managed,
    listener,
    foreign,
    /** Capabilities that fell back or are unavailable (e.g. `ps` denied). */
    degraded,
    uptimeSeconds: managed?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(managed.startedAt)) / 1000)) : null,
    readyUrl: await readyUrlFromLog(cfg),
    isolation: {
      envKeys: Object.keys(env).sort(),
      pathHead: env.PATH.split(':').slice(0, 3),
      desktopEnvRemoved: true,
    },
  });
}

async function startWebInternal(cfg, { waitMs = cfg.readyTimeoutMs, signal } = {}) {
  const initial = await statusOf(cfg);
  if (initial.listening) {
    if (initial.managed && initial.listener && initial.listener.pid === initial.managed.pid) {
      return { action: 'start', started: false, ready: true, reason: 'already-running', status: initial };
    }
    if (cfg.allowForeignTakeover && initial.listener && looksLikeDshWeb(initial.listener.command)) {
      const stopped = await stopWeb(cfg, { reason: 'takeover before start' });
      if (!stopped.stopped) {
        return { action: 'start', started: false, ready: false, reason: 'port-busy', status: await statusOf(cfg) };
      }
    } else {
      return {
        action: 'start',
        started: false,
        ready: false,
        reason: initial.listener ? 'port-busy-foreign' : 'port-busy',
        listener: initial.listener,
        status: initial,
      };
    }
  }

  for (const dir of [path.dirname(cfg.logFile), path.dirname(cfg.pidFile)]) {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      return { action: 'start', started: false, ready: false, reason: 'mkdir-failed', detail: `${dir}: ${err?.message ?? err}` };
    }
  }
  // The profile must already exist: `dsh web` boots from it, and silently
  // creating an empty one only defers the failure to an opaque boot error.
  let profileStat = null;
  try {
    profileStat = await fsp.stat(cfg.profileDir);
  } catch { /* missing */ }
  if (!profileStat?.isDirectory()) {
    return { action: 'start', started: false, ready: false, reason: 'profile-missing', detail: cfg.profileDir };
  }

  await appendMarker(cfg, 'start');
  const env = isolatedEnv(cfg);
  let fd;
  try {
    fd = fs.openSync(cfg.logFile, 'a');
  } catch (err) {
    return { action: 'start', started: false, ready: false, reason: 'log-open-failed', detail: err?.message ?? String(err) };
  }
  let child;
  try {
    child = spawn(cfg.command[0], cfg.command.slice(1), {
      cwd: cfg.profileDir,
      env,
      detached: true, // own session: survives Desktop quit and plugin reload
      stdio: ['ignore', fd, fd],
    });
  } catch (err) {
    fs.closeSync(fd);
    return { action: 'start', started: false, ready: false, reason: 'spawn-failed', detail: err?.message ?? String(err) };
  }
  // Listeners go on before the first await: a failed exec emits 'error' on the
  // next tick, and an unhandled 'error' event would take down the Host process.
  let exited = false;
  let exitCode = null;
  let spawnError = null;
  // A failed exec (missing binary, denied spawn) reports through 'error' and
  // never emits 'exit', so without this the caller would sit out the whole
  // readiness window before reporting a timeout.
  child.once('error', (err) => {
    spawnError = err;
    exited = true;
  });
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  try {
    await writePidFile(cfg, child.pid);
  } catch (err) {
    // The server is already running; a lost pidfile only costs the "managed"
    // label, so keep going and report it instead of failing the start.
    console.error(`[dsh-web-manager] could not write pidfile ${cfg.pidFile}: ${err?.message ?? err}`);
  }
  child.unref();
  setImmediate(() => {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  });

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted?.();
    if (spawnError) {
      await removePidFile(cfg); // the pid was never a live server
      return {
        action: 'start',
        started: false,
        ready: false,
        reason: 'spawn-failed',
        detail: spawnError?.message ?? String(spawnError),
        command: cfg.command,
        status: await statusOf(cfg),
      };
    }
    if (exited) {
      const tail = await tailLog(cfg, { lines: 40 });
      return {
        action: 'start',
        started: true,
        ready: false,
        exited: true,
        reason: 'exited',
        exitCode,
        logTail: tail.lines,
        status: await statusOf(cfg),
      };
    }
    if (await portProbe(cfg, 400)) {
      const status = await statusOf(cfg);
      return { action: 'start', started: true, ready: true, readyUrl: status.readyUrl, status };
    }
    await delay(500);
  }
  return {
    action: 'start',
    started: true,
    ready: false,
    reason: 'ready-timeout',
    detail: `no listener on ${cfg.host}:${cfg.port} within ${Math.round(waitMs / 1000)}s`,
    status: await statusOf(cfg),
  };
}

/** Record why the start ended, then reflect that on the embedded status. */
async function startWeb(cfg, options) {
  const result = await startWebInternal(cfg, options);
  recordStartOutcome(cfg, result);
  if (result && result.status) result.status = applyRuntimeState(cfg, result.status);
  return result;
}

async function stopWeb(cfg, { force = true, graceMs = 12_000, reason } = {}) {
  const status = await statusOf(cfg);
  let target = null;
  let kind = null;
  if (status.managed) {
    target = status.managed.pid;
    kind = 'managed';
  } else if (status.listener) {
    if (cfg.allowForeignTakeover && looksLikeDshWeb(status.listener.command)) {
      target = status.listener.pid;
      kind = 'foreign-dsh-web';
    } else {
      return { action: 'stop', stopped: false, reason: 'foreign-process', listener: status.listener, status };
    }
  } else {
    await removePidFile(cfg);
    clearStartOutcome(cfg); // pressing Stop dismisses a previous start failure
    return { action: 'stop', stopped: true, wasRunning: false, status: applyRuntimeState(cfg, status) };
  }

  await appendMarker(cfg, `stop (${kind}${reason ? `, ${reason}` : ''}) pid=${target}`);
  try { process.kill(target, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await processAlive(target))) break;
    await delay(300);
  }
  let forced = false;
  if (await processAlive(target)) {
    if (!force) {
      return { action: 'stop', stopped: false, reason: 'grace-elapsed', pid: target, status: await statusOf(cfg) };
    }
    forced = true;
    try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
    await delay(500);
  }
  const portDeadline = Date.now() + 5_000;
  while (Date.now() < portDeadline) {
    if (!(await portProbe(cfg, 300))) break;
    await delay(300);
  }
  await removePidFile(cfg);
  clearStartOutcome(cfg);
  return { action: 'stop', stopped: true, wasRunning: true, pid: target, kind, forced, status: await statusOf(cfg) };
}

async function restartWeb(cfg, { waitMs, force, signal } = {}) {
  const stopped = await stopWeb(cfg, { force, reason: 'restart' });
  if (!stopped.stopped) {
    return { action: 'restart', restarted: false, stop: stopped };
  }
  const started = await startWeb(cfg, { waitMs, signal });
  return { action: 'restart', restarted: started.started && started.ready, ...started, stop: { pid: stopped.pid, forced: stopped.forced } };
}

// ---------------------------------------------------------------------------
// agent tool
// ---------------------------------------------------------------------------

function createTool(cfg) {
  return {
    name: 'dsh_web',
    description:
      'Manage the standalone CLI `dsh web` server that serves the user\u2019s own web GUI ' +
      '(default http://127.0.0.1:3080, profile ~/.dsh/profiles/web) independently of this Desktop app. ' +
      'Actions: status reports the listener, the manager-spawned process, an HTTP probe and the newest ' +
      'access URL with its ?token=; start spawns the server detached with an isolated environment; ' +
      'stop terminates the managed process, or a foreign listener only when its command line matches `dsh web`; ' +
      'restart performs stop then start; logs tails the server log. ' +
      'After start or restart, read the returned access URL \u2014 the ?token= changes between boots.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'logs'], description: 'Operation to perform.' },
        lines: { type: 'number', description: 'logs only: trailing lines to return; 200 default, 2000 max.' },
        grep: { type: 'string', description: 'logs only: case-insensitive substring filter.' },
        waitSeconds: { type: 'number', description: 'start and restart only: how long to wait for the port to answer; 90 default, 300 max.' },
        force: { type: 'boolean', description: 'stop and restart only: send SIGKILL when the 12-second graceful window elapses; default true.' },
      },
      required: ['action'],
      additionalProperties: true,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const action = args?.action;
      if (!['status', 'start', 'stop', 'restart', 'logs'].includes(action)) {
        throw new Error(`dsh_web: unknown action ${JSON.stringify(action)}`);
      }
      const waitMs = clampInt(args?.waitSeconds, 5, 300, 90) * 1000;
      const signal = exec?.signal;
      switch (action) {
        case 'status':
          return JSON.stringify(await statusOf(cfg));
        case 'logs':
          return JSON.stringify(await tailLog(cfg, { lines: clampInt(args?.lines, 1, 2000, 200), grep: args?.grep }));
        case 'start':
          return JSON.stringify(await startWeb(cfg, { waitMs, signal }));
        case 'stop':
          return JSON.stringify(await stopWeb(cfg, { force: args?.force !== false }));
        case 'restart':
          return JSON.stringify(await restartWeb(cfg, { waitMs, force: args?.force !== false, signal }));
        default:
          throw new Error(`dsh_web: unhandled action ${JSON.stringify(action)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// web routes for the Client panel
// ---------------------------------------------------------------------------

function isLoopbackAddr(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase();
  return a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function hostNameOf(hostHeader) {
  if (!hostHeader) return '';
  const trimmed = hostHeader.trim();
  const bracket = trimmed.lastIndexOf(']');
  if (trimmed.startsWith('[') && bracket !== -1) return trimmed.slice(1, bracket);
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/**
 * Loopback-only, loopback-Host (anti DNS-rebinding), mutating POSTs only from
 * the Desktop shell or a same-origin page.
 *
 * The Desktop renders this UI at `dsh-desktop://harness/` and proxies requests
 * through HarnessShell.handle, which forwards the browser request after
 * deleting `origin`, `sec-fetch-site` and `host` (rewriting origin only when
 * the renderer supplied one). A panel POST therefore arrives with no
 * Origin/Referer at all, while browsers always attach Origin to a cross-site
 * POST — so an absent source is a trusted local caller, any http(s) source
 * must be same-origin, and `dsh-desktop:` origins are the shell itself.
 */
function fenceOk(ctx, req, res) {
  const remote = req.socket?.remoteAddress ?? '';
  if (!isLoopbackAddr(remote)) {
    sendJson(res, 403, { error: 'non-loopback connection' });
    return false;
  }
  const hostHeader = req.headers.host ?? '';
  if (!isLoopbackAddr(hostNameOf(hostHeader))) {
    sendJson(res, 403, { error: 'untrusted host header' });
    return false;
  }
  if (req.method === 'POST') {
    const origin = req.headers.origin ?? null;
    const referer = req.headers.referer ?? null;
    const source = origin ?? referer ?? '';
    let allowed = source === '';
    if (!allowed) {
      try {
        const url = new URL(source);
        allowed = url.protocol === 'dsh-desktop:' || url.host === hostHeader;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      console.error(
        `[dsh-web-manager] refused ${req.method} ${req.url}: origin=${JSON.stringify(origin)} referer=${JSON.stringify(referer)} host=${JSON.stringify(hostHeader)} sec-fetch-site=${JSON.stringify(req.headers['sec-fetch-site'] ?? null)}`,
      );
      sendJson(res, 403, { error: 'cross-origin request refused' });
      return false;
    }
  }
  const connection = ctx.get('connection');
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection(req);
      if (rejection) {
        sendJson(res, 403, { error: 'request rejected by host policy' });
        return false;
      }
    } catch { /* the explicit fence above already held */ }
  }
  return true;
}

function mountRoutes(ctx, cfg) {
  return ctx.inject(['webServer'], (injected) => {
    // Inside this callback the injected services are exposed as properties on a
    // restricted context proxy: touching any other property — even to type-check
    // the argument — throws `cannot get property "…" without inject`. Resolve
    // the service through the injected name or `get`, never by probing.
    let webServer;
    try {
      webServer = injected?.webServer ?? injected?.get?.('webServer') ?? ctx.get('webServer');
    } catch {
      webServer = ctx.get('webServer');
    }
    if (!webServer || typeof webServer.register !== 'function') return;
    const wrapped = (handler) => async (req, res) => {
      if (!fenceOk(ctx, req, res)) return;
      try {
        await handler(req, res);
      } catch (err) {
        sendJson(res, 500, { error: err?.message ?? String(err) });
      }
    };

    const readBody = (req) => new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 8_192) {
          raw = '';
          req.destroy();
          resolve({});
        }
      });
      req.on('end', () => {
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
      req.on('close', () => resolve({}));
    });

    const queryOf = (req) => new URL(req.url ?? '/', 'http://localhost').searchParams;

    const routes = [
      {
        kind: 'exact',
        path: `${ROUTE_ROOT}/api/health`,
        handler: wrapped(async (_req, res) => sendJson(res, 200, { ok: true, plugin: PLUGIN_ID })),
      },
      {
        kind: 'exact',
        path: `${ROUTE_ROOT}/api/status`,
        handler: wrapped(async (_req, res) => sendJson(res, 200, await statusOf(cfg))),
      },
      {
        kind: 'exact',
        path: `${ROUTE_ROOT}/api/logs`,
        handler: wrapped(async (req, res) => {
          const query = queryOf(req);
          const data = await tailLog(cfg, {
            lines: clampInt(query.get('lines'), 1, 2000, 200),
            grep: query.get('grep') ?? undefined,
          });
          sendJson(res, 200, data);
        }),
      },
      {
        kind: 'exact',
        path: `${ROUTE_ROOT}/api/start`,
        handler: wrapped(async (req, res) => {
          const body = await readBody(req);
          const result = await startWeb(cfg, { waitMs: clampInt(body?.waitSeconds, 5, 300, 90) * 1000 });
          sendJson(res, 200, result);
        }),
      },
      {
        kind: 'exact',
        path: `${ROUTE_ROOT}/api/stop`,
        handler: wrapped(async (req, res) => {
          const body = await readBody(req);
          const result = await stopWeb(cfg, { force: body?.force !== false });
          sendJson(res, 200, result);
        }),
      },
      {
        kind: 'exact',
        path: `${ROUTE_ROOT}/api/restart`,
        handler: wrapped(async (req, res) => {
          const body = await readBody(req);
          const result = await restartWeb(cfg, {
            waitMs: clampInt(body?.waitSeconds, 5, 300, 90) * 1000,
            force: body?.force !== false,
          });
          sendJson(res, 200, result);
        }),
      },
    ];

    const disposers = routes.map((route) => webServer.register(route));
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
  });
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export const inject = ['tools'];

/**
 * The process-identity predicate, exported so `scripts/verify.mjs` can pin the
 * accept/reject matrix offline — it is the only thing standing between a
 * restart and an unrelated process.
 */
export { looksLikeDshWeb };

export function apply(ctx, config) {
  const cfg = defaultConfig(config);
  const disposers = [];
  disposers.push(ctx.effect(() => mountRoutes(ctx, cfg), `${PLUGIN_ID}: panel routes`));
  disposers.push(ctx.tools.register(createTool(cfg)));
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* already disposed */ }
    }
  };
}
