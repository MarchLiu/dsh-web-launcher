/**
 * Client half of @mars.liu/dsh-web-launcher.
 *
 * Registers a sidebar panel icon and a central management panel:
 *   - live status of the standalone CLI `dsh web` server (polled over the
 *     plugin's own loopback, same-origin routes);
 *   - start / restart / stop buttons and an "open web UI" link;
 *   - a tailing log viewer with a filter and auto refresh.
 * All text goes through the Client locale service; all colors are
 * `--dsw-alias-*` theme tokens so the panel follows the host theme.
 */
window.__ModuleLoader__.load({
  id: '@mars.liu/dsh-web-launcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE_ROOT = 'dsh-web-manager/api';

    const DICT = {
      en: {
        'panel.label': 'Web manager',
        'title': 'Dsh Web manager',
        'subtitle': 'Standalone CLI dsh web server, isolated from Desktop',
        'btn.start': 'Start',
        'btn.restart': 'Restart',
        'btn.stop': 'Stop',
        'btn.refresh': 'Refresh',
        'btn.open': 'Open web UI',
        'phase.running': 'Running',
        'phase.stopped': 'Stopped',
        'phase.failed': 'Start failed',
        'phase.foreign': 'External process',
        'phase.exited': 'Exited',
        'phase.checking': 'Checking…',
        'phase.working': 'Working…',
        'failure.title': 'Last start failed',
        'failure.hint': 'Fix the cause above (the log below has the details), then press Start again. The red state clears once the server runs or is stopped.',
        'label.port': 'Port',
        'label.pid': 'Process',
        'label.uptime': 'Uptime',
        'label.http': 'HTTP probe',
        'label.profile': 'Profile directory',
        'label.log': 'Log file',
        'label.command': 'Boot command',
        'label.isolation': 'Isolated env keys',
        'label.path': 'PATH head',
        'label.readyUrl': 'Access URL',
        'foreign.hint': 'An external dsh web process is listening. Because its command line matches `dsh web`, Restart or Stop may take it over; Start will replace it.',
        'degraded.hint': 'Process inspection is unavailable (`ps` was denied), so the pid record is trusted as-is. Start and stop still work; taking over an external listener is refused.',
        'log.title': 'Log tail',
        'log.auto': 'Auto refresh',
        'log.reload': 'Reload',
        'log.grep': 'Filter…',
        'log.empty': 'No log lines.',
        'log.truncated': 'Log is large; showing the last 1 MB.',
        'error.prefix': 'Request failed: ',
      },
      zh: {
        'panel.label': 'Web 管理器',
        'title': 'Dsh Web 管理器',
        'subtitle': '独立 CLI dsh web 服务，与 Desktop 环境隔离',
        'btn.start': '启动',
        'btn.restart': '重启',
        'btn.stop': '停止',
        'btn.refresh': '刷新',
        'btn.open': '打开 Web UI',
        'phase.running': '运行中',
        'phase.stopped': '已停止',
        'phase.failed': '启动失败',
        'phase.foreign': '外部进程',
        'phase.exited': '已退出',
        'phase.checking': '检查中…',
        'phase.working': '执行中…',
        'failure.title': '上次启动失败',
        'failure.hint': '请按上方原因排查（下方日志中有详细信息），然后重新启动；服务恢复运行或手动停止后，红色状态会自动清除。',
        'label.port': '端口',
        'label.pid': '进程',
        'label.uptime': '运行时长',
        'label.http': 'HTTP 探测',
        'label.profile': 'Profile 目录',
        'label.log': '日志文件',
        'label.command': '启动命令',
        'label.isolation': '隔离环境变量',
        'label.path': 'PATH 前缀',
        'label.readyUrl': '访问地址',
        'foreign.hint': '当前有一个外部 dsh web 进程在监听。由于其命令行匹配 `dsh web`，重启/停止可以接管它，启动也会先替换它。',
        'degraded.hint': '进程信息不可用（`ps` 被拒绝），当前直接信任 pid 记录。启动/停止仍可用；不会接管外部监听进程。',
        'log.title': '日志末尾',
        'log.auto': '自动刷新',
        'log.reload': '重新加载',
        'log.grep': '过滤…',
        'log.empty': '暂无日志。',
        'log.truncated': '日志较大，仅显示最后 1 MB。',
        'error.prefix': '请求失败：',
      },
    };

    const CSS = `
.dswm-root{display:flex;flex-direction:column;gap:14px;height:100%;overflow-y:auto;box-sizing:border-box;padding:20px 24px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;}
.dswm-header{display:flex;flex-direction:column;gap:10px;}
.dswm-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dswm-title{font-size:16px;font-weight:600;margin:0;}
.dswm-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none;}
.dswm-dot.run{background:var(--dsw-alias-state-success-primary);}
.dswm-dot.stop{background:var(--dsw-alias-state-idle-primary);}
.dswm-dot.warn{background:var(--dsw-alias-state-warn-primary);}
.dswm-dot.fail{background:var(--dsw-alias-state-error-primary);}
.dswm-phase{display:inline-flex;align-items:center;border:1px solid transparent;border-radius:999px;padding:1px 9px;font-size:11.5px;font-weight:600;white-space:nowrap;}
.dswm-phase.run{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);}
.dswm-phase.stop{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}
.dswm-phase.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);}
.dswm-phase.fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);}
.dswm-sub{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dswm-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.dswm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 14px;font-size:13px;cursor:pointer;}
.dswm-btn:hover{border-color:var(--dsw-alias-border-l2);}
.dswm-btn:disabled{opacity:.5;cursor:default;}
.dswm-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#ffffff;}
.dswm-btn.primary:hover{filter:brightness(1.06);}
.dswm-banner{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 12px;}
.dswm-failure{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:9px 12px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);word-break:break-word;}
.dswm-failure-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.dswm-failure-head strong{color:var(--dsw-alias-state-error-primary);}
.dswm-failure-reason{color:var(--dsw-alias-state-error-primary);}
.dswm-note{border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 12px;}
.dswm-grid{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;align-items:baseline;margin:0;}
.dswm-grid dt{color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dswm-grid dd{margin:0;word-break:break-all;}
.dswm-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}
.dswm-link{color:var(--dsw-alias-brand-primary);text-decoration:none;}
.dswm-link:hover{text-decoration:underline;}
.dswm-log{display:flex;flex-direction:column;gap:8px;flex:1;min-height:260px;}
.dswm-log-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;}
.dswm-log-title{font-weight:600;}
.dswm-log-tools{display:flex;gap:8px;align-items:center;margin-left:auto;color:var(--dsw-alias-label-secondary);}
.dswm-input{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font-size:12px;}
.dswm-pre{margin:0;flex:1;overflow-y:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);}
.dswm-check{display:inline-flex;gap:5px;align-items:center;cursor:pointer;user-select:none;}
`;

    function api(path) {
      if (typeof document === 'undefined') return `/${path}`;
      return new URL(path.replace(/^\/+/, ''), document.baseURI).pathname;
    }

    async function callJson(path, options) {
      const res = await fetch(api(path), options);
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    }

    function formatUptime(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
      const s = Math.round(seconds);
      const m = Math.floor(s / 60);
      const hh = Math.floor(m / 60);
      if (hh > 0) return `${hh}h ${m % 60}m`;
      if (m > 0) return `${m}m ${s % 60}s`;
      return `${s}s`;
    }

    // -----------------------------------------------------------------------
    // shared status store
    // -----------------------------------------------------------------------

    const STATUS_ROUTE = `${ROUTE_ROOT}/status`;
    const PANEL_POLL_MS = 4000;
    const IDLE_POLL_MS = 15000;

    /** Sidebar icon tint per state; the panel reuses the same idea in CSS. */
    const TONE_COLOR = {
      run: 'var(--dsw-alias-state-success-primary)',
      stop: 'var(--dsw-alias-label-secondary)', // idle-primary is too faint to read as an icon in light mode
      fail: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    function phaseOf(status) {
      if (!status) return 'checking';
      if (status.state === 'running' || status.state === 'failed' || status.state === 'foreign') return status.state;
      // Older Host half: derive the same tri-state from the raw probe.
      if (status.listening) return status.foreign ? 'foreign' : 'running';
      if (status.failure || status.lastStart?.ok === false) return 'failed';
      return 'stopped';
    }

    function toneOf(phase, pending) {
      if (pending) return 'warn';
      if (phase === 'running') return 'run';
      if (phase === 'failed') return 'fail';
      if (phase === 'foreign') return 'warn';
      return 'stop';
    }

    /**
     * One poller shared by the sidebar icon and the panel, so both always paint
     * the same state. The sidebar alone polls slowly; opening the panel makes
     * the same poller fast. Requests are skipped while the page is hidden and
     * the timer stops entirely when nothing is subscribed.
     */
    function createStatusStore() {
      let snapshot = { status: null, error: null, pending: null };
      const listeners = new Set();
      let timer = null;
      let panelOpen = false;
      let polling = false;

      const emit = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) {
          try { listener(snapshot); } catch { /* one bad subscriber must not starve the rest */ }
        }
      };

      const refresh = async () => {
        if (polling) return;
        polling = true;
        try {
          const data = await callJson(STATUS_ROUTE);
          emit({ status: data, error: null });
        } catch (err) {
          emit({ error: String(err?.message ?? err) });
        } finally {
          polling = false;
        }
      };

      const schedule = () => {
        if (timer !== null) clearInterval(timer);
        timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          refresh();
        }, panelOpen ? PANEL_POLL_MS : IDLE_POLL_MS);
      };

      const onVisible = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh();
      };

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) {
            schedule();
            refresh();
            if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
              if (timer !== null) clearInterval(timer);
              timer = null;
              if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
            }
          };
        },
        refresh,
        setPanelOpen(open) {
          if (panelOpen === open) return;
          panelOpen = open;
          if (timer !== null) schedule();
          if (open) refresh();
        },
        beginAction(name) { emit({ pending: name }); },
        endAction() { emit({ pending: null }); },
        setStatus(status) { emit({ status, error: null }); },
        setError(error) { emit({ error: String(error?.message ?? error) }); },
      };
    }

    const statusStore = createStatusStore();

    function useStatusStore() {
      const [snapshot, setSnapshot] = React.useState(statusStore.getSnapshot());
      React.useEffect(() => statusStore.subscribe(setSnapshot), []);
      return snapshot;
    }

    function PanelIcon({ t, size, active }) {
      const { status, pending } = useStatusStore();
      const phase = pending ? 'working' : phaseOf(status);
      const tone = toneOf(phase, pending);
      const label = `${t('panel.label')}: ${pending ? t('phase.working') : t(`phase.${phase}`)}`;
      const dimension = size || 20;
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 24 24',
        fill: 'none',
        role: 'img',
        'aria-label': label,
        style: { display: 'block', opacity: active ? 1 : 0.92, color: TONE_COLOR[tone] },
      }, [
        h('title', { key: 'title' }, label),
        h('circle', { key: 'g', cx: 10.5, cy: 13.5, r: 6.3, stroke: 'currentColor', 'stroke-width': 1.8 }),
        h('path', {
          key: 'm', d: 'M4.2 13.5h12.6M10.5 7.2c2.7 2.2 2.7 10.4 0 12.6',
          stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round',
        }),
        h('path', {
          key: 'a', d: 'M17 3.6a8.6 8.6 0 0 1 4 5.6',
          stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round',
        }),
        h('path', {
          key: 'h', d: 'M21.6 6.6l-.5-3M21.6 6.6l-3-.4',
          stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }),
      ]);
    }

    function ManagerPage({ t }) {
      const { status, error: statusError, pending } = useStatusStore();
      const [logError, setLogError] = React.useState(null);
      const [logs, setLogs] = React.useState(null);
      const [logLines, setLogLines] = React.useState(200);
      const [grep, setGrep] = React.useState('');
      const [autoRefresh, setAutoRefresh] = React.useState(true);
      const preRef = React.useRef(null);
      const firstLoad = React.useRef(true);

      const loadLogs = React.useCallback(async (lines, filter) => {
        try {
          const query = new URLSearchParams({ lines: String(lines) });
          if (filter) query.set('grep', filter);
          const data = await callJson(`${ROUTE_ROOT}/logs?${query.toString()}`);
          setLogs(data);
          setLogError(null);
        } catch (err) {
          setLogError(String(err?.message ?? err));
        }
      }, []);

      React.useEffect(() => {
        statusStore.setPanelOpen(true);
        return () => statusStore.setPanelOpen(false);
      }, []);

      React.useEffect(() => {
        if (!firstLoad.current) return;
        firstLoad.current = false;
        loadLogs(logLines, grep);
      }, [loadLogs, logLines, grep]);

      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return;
          if (autoRefresh) loadLogs(logLines, grep);
        }, 4000);
        return () => clearInterval(timer);
      }, [autoRefresh, loadLogs, logLines, grep]);

      React.useEffect(() => {
        if (autoRefresh && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
      }, [logs, autoRefresh]);

      const act = React.useCallback(async (name, body) => {
        statusStore.beginAction(name);
        try {
          const result = await callJson(`${ROUTE_ROOT}/${name}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          });
          if (result && result.status) statusStore.setStatus(result.status);
          else if (result && result.ready === false) await statusStore.refresh();
          await loadLogs(logLines, grep);
        } catch (err) {
          statusStore.setError(err);
        } finally {
          statusStore.endAction();
        }
      }, [loadLogs, logLines, grep]);

      const error = logError || statusError;
      const working = pending !== null;
      const phase = working ? 'working' : phaseOf(status);
      const tone = toneOf(phase, working);
      const exited = phase === 'failed' && status?.failure?.reason === 'exited';
      const phaseText = working ? t('phase.working') : exited ? t('phase.exited') : t(`phase.${phase}`);
      const pidText = status
        ? (status.managed ? `pid ${status.managed.pid}${status.foreign && status.listener ? ` (listener pid ${status.listener.pid})` : ''}`
          : status.listener ? `pid ${status.listener.pid} (external)` : '—')
        : '—';

      const rows = [];
      const row = (label, value, code) => rows.push(
        h('dt', { key: `${label}-k` }, label),
        h('dd', { key: `${label}-v`, className: code ? 'dswm-code' : undefined }, value),
      );
      row(t('label.port'), status ? `${status.target.host}:${status.target.port}` : '—', true);
      row(t('label.pid'), pidText);
      row(t('label.uptime'), status ? formatUptime(status.uptimeSeconds) : '—');
      row(t('label.http'), status ? (status.httpStatus ? `HTTP ${status.httpStatus}` : status.listening ? 'listening' : '—') : '—');
      row(t('label.profile'), status ? status.target.profileDir : '—', true);
      row(t('label.log'), status ? status.target.logFile : '—', true);
      row(t('label.command'), status ? status.target.command.join(' ') : '—', true);
      row(t('label.isolation'), status ? status.isolation.envKeys.join(', ') : '—', true);
      row(t('label.path'), status ? status.isolation.pathHead.join(' : ') : '—', true);
      if (status && status.readyUrl) {
        rows.push(
          h('dt', { key: 'url-k' }, t('label.readyUrl')),
          h('dd', { key: 'url-v', className: 'dswm-code' },
            h('a', { className: 'dswm-link', href: status.readyUrl, target: '_blank', rel: 'noreferrer' }, status.readyUrl)),
        );
      }

      return h('div', { className: 'dswm-root' }, [
        h('style', null, CSS),
        h('div', { className: 'dswm-header' }, [
          h('div', { className: 'dswm-title-row' }, [
            h('span', { className: `dswm-dot ${tone}`, 'aria-hidden': true }),
            h('h1', { className: 'dswm-title' }, t('title')),
            h('span', { className: `dswm-phase ${tone}` }, phaseText),
            h('span', { className: 'dswm-sub' }, t('subtitle')),
          ]),
          h('div', { className: 'dswm-actions' }, [
            h('button', {
              className: 'dswm-btn primary', disabled: working,
              onClick: () => act('start', {}), title: t('btn.start'),
            }, t('btn.start')),
            h('button', {
              className: 'dswm-btn primary', disabled: working,
              onClick: () => act('restart', {}),
            }, t('btn.restart')),
            h('button', {
              className: 'dswm-btn', disabled: working,
              onClick: () => act('stop', { force: true }),
            }, t('btn.stop')),
            h('button', { className: 'dswm-btn', disabled: working, onClick: () => { statusStore.refresh(); loadLogs(logLines, grep); } }, t('btn.refresh')),
            status && status.readyUrl
              ? h('a', { className: 'dswm-link', href: status.readyUrl, target: '_blank', rel: 'noreferrer' },
                h('button', { className: 'dswm-btn' }, t('btn.open')))
              : null,
          ]),
        ]),
        error ? h('div', { className: 'dswm-banner', role: 'alert' }, `${t('error.prefix')}${error}`) : null,
        status && phase === 'failed' && status.failure
          ? h('div', { className: 'dswm-failure', role: 'status' }, [
            h('div', { className: 'dswm-failure-head' }, [
              h('strong', null, t('failure.title')),
              status.failure.reason
                ? h('code', { className: 'dswm-code dswm-failure-reason' }, status.failure.reason)
                : null,
              Number.isInteger(status.failure.exitCode)
                ? h('code', { className: 'dswm-code' }, `exit ${status.failure.exitCode}`)
                : null,
            ]),
            status.failure.detail ? h('div', { className: 'dswm-sub' }, status.failure.detail) : null,
            h('div', { className: 'dswm-sub' }, t('failure.hint')),
          ])
          : null,
        status && status.foreign ? h('div', { className: 'dswm-note' }, t('foreign.hint')) : null,
        status && Array.isArray(status.degraded) && status.degraded.length
          ? h('div', { className: 'dswm-note' }, t('degraded.hint'))
          : null,
        h('dl', { className: 'dswm-grid' }, rows),
        h('div', { className: 'dswm-log' }, [
          h('div', { className: 'dswm-log-head' }, [
            h('span', { className: 'dswm-log-title' }, t('log.title')),
            h('span', { className: 'dswm-log-tools' }, [
              h('label', { className: 'dswm-check' }, [
                h('input', {
                  type: 'checkbox', checked: autoRefresh,
                  onChange: (e) => setAutoRefresh(e.target.checked),
                }),
                t('log.auto'),
              ]),
              h('select', {
                className: 'dswm-input', value: String(logLines),
                onChange: (e) => { const n = Number(e.target.value); setLogLines(n); loadLogs(n, grep); },
                'aria-label': t('log.title'),
              }, [200, 500, 1000, 2000].map((n) => h('option', { key: n, value: String(n) }, String(n)))),
              h('input', {
                className: 'dswm-input', type: 'search', placeholder: t('log.grep'), value: grep,
                onChange: (e) => setGrep(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') loadLogs(logLines, grep); },
              }),
              h('button', { className: 'dswm-btn', onClick: () => loadLogs(logLines, grep) }, t('log.reload')),
            ]),
          ]),
          logs && logs.truncated ? h('div', { className: 'dswm-sub' }, t('log.truncated')) : null,
          h('pre', { className: 'dswm-pre', ref: preRef },
            logs && logs.lines.length ? logs.lines.join('\n') : t('log.empty')),
        ]),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale;
        let t = (key) => (DICT.en[key] ?? key);
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          try {
            // One call with both baseline locales: the namespace either gets
            // both dictionaries or neither, so a partial registration can never
            // surface as raw keys in one language. `en` also gates the fallback
            // chain, so it must ship alongside `zh`.
            locale.register('dshWebManager', { en: DICT.en, zh: DICT.zh });
            t = locale.bind('dshWebManager');
          } catch {
            t = (key) => (DICT.en[key] ?? key);
          }
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-web-manager', order: 60, label: () => t('panel.label') },
          (props) => h(PanelIcon, { t, size: props?.size, active: props?.active }),
        ));

        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'dsh-web-manager' },
          (props) => h(ManagerPage, { t, panelInfo: props?.panelInfo }),
        ));
      },
    };
  },
});
