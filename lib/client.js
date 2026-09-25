/**
 * dsh-plugin-fennara — browser half.
 *
 * Hand-written client bundle in the harness's lazy-CJS form
 * (`window.__ModuleLoader__.load({ id, factory })`): executing this file only
 * registers a factory, and the factory runs when the module is materialized.
 *
 * It contributes one list entry to the sidebar's footer actions — a live status
 * dot plus a panel with the Fennara/Godot state and the connect / switch
 * buttons. All data comes from this plugin's own `/fennara/api/*` routes, so no
 * RPC framework or build step is involved.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-fennara',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    // UI atoms are used when the platform provides them; the fallbacks keep the
    // panel usable (plain DOM, still themed through the same CSS variables)
    // instead of failing the whole bundle on one missing export.
    let primitives = {};
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {};
    } catch (error) {
      primitives = {};
    }

    function FallbackButton(props) {
      const { variant, size, icon, children, style, ...rest } = props;
      return h(
        'button',
        {
          type: 'button',
          ...rest,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: size === 'sm' ? '3px 10px' : '6px 14px',
            borderRadius: '8px',
            font: 'inherit',
            cursor: rest.disabled === true ? 'default' : 'pointer',
            border: variant === 'primary' ? '1px solid transparent' : '1px solid rgba(255,255,255,0.18)',
            background: variant === 'primary' ? '#4d6bfe' : 'transparent',
            color: 'inherit',
            opacity: rest.disabled === true ? 0.45 : 1,
            ...style,
          },
        },
        icon,
        children,
      );
    }

    function FallbackStateDot(props) {
      const colors = { done: '#3fb950', warning: '#d29922', ongoing: '#58a6ff', error: '#f85149' };
      const size = props.size || 10;
      return h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block',
          flex: '0 0 auto',
          width: size + 'px',
          height: size + 'px',
          borderRadius: '50%',
          background: colors[props.state] || '#8b949e',
        },
      });
    }

    function FallbackPill(props) {
      return h(
        'span',
        {
          style: {
            padding: '1px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            lineHeight: '16px',
            whiteSpace: 'nowrap',
            border: '1px solid rgba(255,255,255,0.18)',
            background: props.active === true ? 'rgba(77,107,254,0.28)' : 'transparent',
          },
        },
        props.children,
      );
    }

    function FallbackModal(props) {
      if (props.open !== true) return null;
      return h(
        'div',
        {
          role: 'dialog',
          'aria-label': props.title,
          onClick: props.onClose,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)',
          },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              width: 'min(760px, 94vw)',
              maxHeight: '82vh',
              overflow: 'auto',
              padding: '16px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'var(--dsw-alias-bg-elevated, #1b1b1f)',
              color: 'inherit',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
            h('strong', null, props.title),
            h(
              'button',
              {
                type: 'button',
                onClick: props.onClose,
                'aria-label': props.closeLabel || 'close',
                style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px' },
              },
              '\u00d7',
            ),
          ),
          props.children,
        ),
      );
    }

    const Button = typeof primitives.Button === 'function' ? primitives.Button : FallbackButton;
    const StateDot = typeof primitives.StateDot === 'function' ? primitives.StateDot : FallbackStateDot;
    const Pill = typeof primitives.Pill === 'function' ? primitives.Pill : FallbackPill;
    const Modal = typeof primitives.Modal === 'function' ? primitives.Modal : FallbackModal;

    const API = '/fennara/api';
    const POLL_MS = 5000;

    async function call(path, body) {
      const options =
        body === undefined
          ? { method: 'GET' }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      const response = await fetch(API + path, options);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    function useStatus() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null });
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const data = await call('/status');
            if (alive) setState({ loading: false, error: null, data });
          } catch (error) {
            if (alive)
              setState((previous) => ({
                loading: false,
                error: String((error && error.message) || error),
                data: previous.data,
              }));
          }
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      return [state, setState];
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 0',
      borderTop: '1px solid rgba(255,255,255,0.08)',
    };
    const mutedStyle = { opacity: 0.65, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const sectionTitleStyle = { margin: '14px 0 4px', fontSize: '12px', opacity: 0.7, letterSpacing: '0.04em' };
    const groupHeaderStyle = { margin: '10px 0 2px', fontSize: '12px', fontWeight: 600, opacity: 0.85 };

    /**
     * Projects without the addon start collapsed: they cannot be bound until
     * Fennara is installed into them, so they should not push the usable ones
     * off screen. Named so the intent survives the `useState` call.
     */
    const OTHERS_START_COLLAPSED = true;

    /**
     * Every user-visible string in this panel, in both languages the harness
     * ships. English is the harness fallback locale, so it is the fallback here
     * too: a key missing from the active table resolves against `en`, and the
     * two tables are kept key-for-key identical (asserted by the self-test).
     */
    const TEXTS = {
      en: {
        'trigger.title': 'Fennara · Godot',
        'trigger.offline': 'Fennara offline',
        'trigger.idle': 'Fennara',
        'modal.title': 'Fennara · Godot connection',
        'modal.description': 'Status refreshes every {seconds} s',
        'modal.close': 'Close',
        'action.follow': 'Follow editor',
        'action.rescan': 'Rescan',
        'action.disconnect': 'Disconnect',
        'action.checkUpdates': 'Check updates',
        'action.connect': 'Connect',
        'action.reconnect': 'Reconnect',
        'action.expand': 'Show',
        'action.collapse': 'Hide',
        'busy.connecting': 'Connecting…',
        'busy.scanning': 'Scanning…',
        'busy.checking': 'Checking…',
        'section.environment': 'Environment',
        'section.editors': 'Running Godot editors ({count})',
        'section.registry': 'Project registry ({count}) · most recently used first',
        'group.bindable': 'Can connect · has the Fennara addon ({count})',
        'group.unbindable': 'Cannot connect · no Fennara addon ({count})',
        'group.noBindable': 'No project has the Fennara addon yet',
        'group.noEditors': 'No running Godot editor detected',
        'field.install': 'Fennara: {state}',
        'field.install.ok': 'installed {version}',
        'field.install.missing': 'not found',
        'field.install.launcher': 'record unreadable, using the launcher',
        'field.daemon': 'daemon: {state}',
        'field.daemon.up': 'connected (port {port})',
        'field.daemon.down': 'not reachable (port {port})',
        'field.daemon.discovered': 'discovered automatically',
        'field.bound': 'Connected project: {state}',
        'field.bound.none': 'none',
        'field.bound.some': '{name} ({count} tools)',
        'field.bound.viaEnv': 'bound through the environment variable',
        'field.roots': 'Scan roots: {roots}',
        'field.roots.none': 'not configured',
        'marker.noAddon': 'no addon',
        'marker.running': 'running',
        'marker.connected': 'connected',
        'meta.lastUsed': ' · last used {when}',
        'editor.unknownProject': 'unknown project',
        'age.now': 'just now',
        'age.minutes': '{n} min ago',
        'age.hours': '{n} h ago',
        'age.days': '{n} d ago',
        'age.months': '{n} mo ago',
        'age.years': '{n} y ago',
        'status.readFailed': 'Could not read status: {error}',
        'status.requestFailed': 'Request failed: {error}',
        'update.current': 'Up to date on GitHub ({version})',
        'update.available': 'Version {version} available (local {local})',
        'update.incomparable': 'Latest release is {version}; cannot compare with the local version',
        'update.failed': 'Update check failed: {error}',
        'update.open': 'Open release page',
        'update.stale': '· {count} project(s) carry an older addon: {list}',
        'msg.bound': 'Connected {name} as {server} ({count} tools)',
        'msg.scanned': 'Rescanned: {count} project(s)',
        'msg.disconnected': 'Disconnected {name}',
        'msg.nothingConnected': 'Nothing was connected',
        'msg.done': 'Done',
        'err.no_editor': 'No running Godot editor found — open the project in Godot first.',
        'err.ambiguous': 'More than one Godot editor is running — pick a project explicitly.',
        'err.not_found': 'No project matches "{query}" — rescan the folder that contains it.',
        'err.no_addon': 'No Fennara addon in that project — run fennara install --project "{path}".',
        'err.no_launcher': 'The Fennara launcher was not found — install or repair Fennara first.',
        'err.bad_request': 'Nothing to do.',
      },
      zh: {
        'trigger.title': 'Fennara · Godot',
        'trigger.offline': 'Fennara 离线',
        'trigger.idle': 'Fennara',
        'modal.title': 'Fennara · Godot 连接',
        'modal.description': '状态每 {seconds} 秒刷新一次',
        'modal.close': '关闭',
        'action.follow': '跟随当前编辑器',
        'action.rescan': '重新扫描',
        'action.disconnect': '断开绑定',
        'action.checkUpdates': '检查更新',
        'action.connect': '绑定',
        'action.reconnect': '重新绑定',
        'action.expand': '展开',
        'action.collapse': '收起',
        'busy.connecting': '绑定中…',
        'busy.scanning': '扫描中…',
        'busy.checking': '检查中…',
        'section.environment': '运行环境',
        'section.editors': '运行中的 Godot 编辑器（{count}）',
        'section.registry': '工程仓库（{count}）· 按最近使用排序',
        'group.bindable': '可绑定 · 含 Fennara addon（{count}）',
        'group.unbindable': '不可绑定 · 无 Fennara addon（{count}）',
        'group.noBindable': '没有已装 Fennara addon 的工程',
        'group.noEditors': '未检测到正在运行的 Godot 编辑器',
        'field.install': 'Fennara：{state}',
        'field.install.ok': '已安装 {version}',
        'field.install.missing': '未找到',
        'field.install.launcher': '记录不可读，走启动器',
        'field.daemon': 'daemon：{state}',
        'field.daemon.up': '已连接（端口 {port}）',
        'field.daemon.down': '未连接（端口 {port}）',
        'field.daemon.discovered': '自动发现',
        'field.bound': '当前绑定：{state}',
        'field.bound.none': '无',
        'field.bound.some': '{name}（{count} 个工具）',
        'field.bound.viaEnv': '经环境变量兜底',
        'field.roots': '扫描根：{roots}',
        'field.roots.none': '未配置',
        'marker.noAddon': '无 addon',
        'marker.running': '运行中',
        'marker.connected': '已绑定',
        'meta.lastUsed': ' · 最近使用：{when}',
        'editor.unknownProject': '未知工程',
        'age.now': '刚刚',
        'age.minutes': '{n} 分钟前',
        'age.hours': '{n} 小时前',
        'age.days': '{n} 天前',
        'age.months': '{n} 个月前',
        'age.years': '{n} 年前',
        'status.readFailed': '状态读取失败：{error}',
        'status.requestFailed': '请求失败：{error}',
        'update.current': 'GitHub 上已是最新（{version}）',
        'update.available': '发现新版本 {version}（本地 {local}）',
        'update.incomparable': '最新发布 {version}，无法与本地版本比较',
        'update.failed': '更新检查失败：{error}',
        'update.open': '打开发布页',
        'update.stale': '· {count} 个工程的 addon 落后：{list}',
        'msg.bound': '已绑定 {name}（{server}，{count} 个工具）',
        'msg.scanned': '已重新扫描：{count} 个工程',
        'msg.disconnected': '已断开 {name}',
        'msg.nothingConnected': '当前没有绑定。',
        'msg.done': '完成',
        'err.no_editor': '没有检测到正在运行的 Godot 编辑器 —— 请先在 Godot 中打开工程。',
        'err.ambiguous': '检测到多个 Godot 编辑器 —— 请显式指定工程。',
        'err.not_found': '仓库里没有匹配 “{query}” 的工程 —— 请先扫描它所在的目录。',
        'err.no_addon': '该工程没有安装 Fennara addon —— 可运行 fennara install --project "{path}"。',
        'err.no_launcher': '找不到 Fennara 启动器 —— 请先安装或修复 Fennara。',
        'err.bad_request': '没有可执行的操作。',
      },
    };

    /**
     * The active UI language. Read from the harness locale service so the panel
     * follows the Language setting instead of guessing; the browser preference
     * only decides when that service is absent (for example in a bare render).
     */
    function activeLocale(ctx) {
      try {
        const snapshot = ctx && ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot() : null;
        if (snapshot && typeof snapshot.active === 'string' && snapshot.active.length > 0) return snapshot.active;
      } catch {
        /* fall through to the browser preference */
      }
      const preferred = typeof navigator !== 'undefined' ? navigator.language : null;
      return typeof preferred === 'string' && preferred.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /** Look a key up in `locale`, then in English, then give the key back. */
    function translate(locale, key, params) {
      const table = TEXTS[locale] || TEXTS.en;
      const template = typeof table[key] === 'string' ? table[key] : TEXTS.en[key];
      if (typeof template !== 'string') return key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    /** Re-render on a locale switch so an explicit Language change takes effect. */
    function useLocale(ctx) {
      const [locale, setLocale] = React.useState(() => activeLocale(ctx));
      React.useEffect(() => {
        const service = ctx && ctx.locale;
        if (service === undefined || typeof service.subscribe !== 'function') return undefined;
        const sync = () => setLocale(activeLocale(ctx));
        sync();
        // Call it ON the service. `subscribe` uses `this.listeners`, so detaching it
        // into a local and calling that throws "Cannot read properties of undefined
        // (reading 'listeners')" — the receiver is part of the contract, and the
        // built-in callers keep it (`locale.subscribe(sync)` in dsh-client-locale).
        const unsubscribe = service.subscribe(sync);
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, []);
      return locale;
    }

    /** Relative age, formatted here so the panel never mixes two languages. */
    function formatAge(at, t, now) {
      if (!Number.isFinite(at)) return null;
      const reference = Number.isFinite(now) ? now : Date.now();
      const seconds = Math.max(0, Math.round((reference - at) / 1000));
      if (seconds < 90) return t('age.now');
      const minutes = Math.round(seconds / 60);
      if (minutes < 90) return t('age.minutes', { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 36) return t('age.hours', { n: hours });
      const days = Math.round(hours / 24);
      if (days < 45) return t('age.days', { n: days });
      const months = Math.round(days / 30);
      if (months < 18) return t('age.months', { n: months });
      return t('age.years', { n: Math.round(months / 12) });
    }

    /** Render the remembered release-check result: a line, never a request. */
    function updateLine(update, t) {
      if (!update) return null;
      const wrap = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' };
      if (update.ok !== true) {
        return h('div', { style: Object.assign({}, wrap, { color: '#f85149' }) }, t('update.failed', { error: update.error || '?' }));
      }
      let summary;
      if (update.upToDate === true) summary = t('update.current', { version: update.latestVersion });
      else if (update.upToDate === false)
        summary = t('update.available', { version: update.latestVersion, local: update.localVersion || '?' });
      else summary = t('update.incomparable', { version: update.latestVersion });

      const children = [h('span', null, summary)];
      if (update.upToDate === false && update.releaseUrl) {
        children.push(h('a', { href: update.releaseUrl, target: '_blank', rel: 'noreferrer' }, t('update.open')));
      }
      const stale = Array.isArray(update.staleProjects) ? update.staleProjects : [];
      if (stale.length > 0) {
        children.push(
          h(
            'span',
            { style: mutedStyle },
            t('update.stale', {
              count: stale.length,
              list: stale.map((item) => `${item.name} ${item.version}`).join(', '),
            }),
          ),
        );
      }
      return h('div', { style: wrap }, children);
    }

    function FennaraAction(props) {
      const wide = props.wide !== false;
      const locale = useLocale(props.clientCtx);
      const t = (key, params) => translate(locale, key, params);
      const [state, setState] = useStatus();
      const [open, setOpen] = React.useState(false);
      const [othersCollapsed, setOthersCollapsed] = React.useState(OTHERS_START_COLLAPSED);
      const [busy, setBusy] = React.useState(null);
      const [message, setMessage] = React.useState(null);

      const data = state.data;
      const bound = data && data.bound;
      const daemonUp = Boolean(data && data.daemon && data.daemon.reachable);
      const dotState = !data ? 'warning' : daemonUp ? (bound ? 'done' : 'ongoing') : 'error';
      const label = bound
        ? 'Fennara · ' + bound.name
        : daemonUp
          ? t('trigger.idle')
          : t('trigger.offline');

      /**
       * Build the toast here from the structured result rather than echoing the
       * backend's sentence, so feedback follows the UI language. Free-form
       * diagnostics the client cannot translate fall back to the backend text.
       */
      function describe(name, result) {
        if (!result || typeof result !== 'object') return t('msg.done');
        if (name === 'scan') {
          return result.ok === true ? t('msg.scanned', { count: result.count || 0 }) : result.message || t('msg.done');
        }
        if (name === 'unbind') {
          return result.released ? t('msg.disconnected', { name: result.released }) : t('msg.nothingConnected');
        }
        if (name === 'update') {
          if (result.ok !== true) return t('update.failed', { error: result.error || '?' });
          if (result.upToDate === true) return t('update.current', { version: result.latestVersion });
          if (result.upToDate === false) {
            return t('update.available', { version: result.latestVersion, local: result.localVersion || '?' });
          }
          return t('update.incomparable', { version: result.latestVersion });
        }
        // bind / auto
        if (result.ok === true) {
          return t('msg.bound', {
            name: result.project ? result.project.name : '',
            server: result.serverName || '',
            count: Array.isArray(result.tools) ? result.tools.length : 0,
          });
        }
        const code = typeof result.code === 'string' ? result.code : null;
        if (code !== null && code !== 'bind_failed') {
          return t('err.' + code, {
            query: result.query || (result.project ? result.project.name : ''),
            path: result.project ? result.project.path : '',
          });
        }
        return result.message || t('msg.done');
      }

      async function run(name, path, body) {
        setBusy(name);
        setMessage(null);
        try {
          const result = await call(path, body);
          if (result && result.status) setState({ loading: false, error: null, data: result.status });
          setMessage(describe(name, result));
        } catch (error) {
          setMessage(t('status.requestFailed', { error: String((error && error.message) || error) }));
        } finally {
          setBusy(null);
        }
      }

      const trigger = h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          title: t('trigger.title'),
          onClick: () => setOpen(true),
          style: wide
            ? { width: '100%', justifyContent: 'flex-start', gap: '8px' }
            : { width: '100%', justifyContent: 'center', padding: '4px 0' },
        },
        h(StateDot, { state: dotState, size: wide ? 8 : 10 }),
        wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label) : null,
      );

      if (!open) return trigger;

      const editors = (data && data.editors) || [];
      const projects = (data && data.projects) || [];
      const bindable = projects.filter((project) => project.hasFennaraAddon === true);
      const unbindable = projects.filter((project) => project.hasFennaraAddon !== true);
      const install = (data && data.install) || null;

      // One row renderer for both groups; only a bindable project gets the button.
      const projectRow = (project) => {
        const age = formatAge(project.lastUsedAt !== null ? project.lastUsedAt : project.recentAt, t);
        return h(
          'div',
          { key: project.path, style: rowStyle },
          h(StateDot, {
            state: project.bound ? 'done' : project.running ? 'ongoing' : project.hasFennaraAddon ? 'warning' : 'error',
          }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, project.name),
              project.hasFennaraAddon
                ? h(Pill, null, 'fennara ' + (project.fennaraVersion || ''))
                : h(Pill, null, t('marker.noAddon')),
              project.running ? h(Pill, { active: true }, t('marker.running')) : null,
              project.bound ? h(Pill, { active: true }, t('marker.connected')) : null,
            ),
            h('div', { style: mutedStyle }, project.path + (age ? t('meta.lastUsed', { when: age }) : '')),
          ),
          project.hasFennaraAddon
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: project.bound ? 'outline' : 'primary',
                  disabled: busy !== null,
                  onClick: () => run('bind-' + project.name, '/bind', { project: project.path }),
                },
                busy === 'bind-' + project.name
                  ? t('busy.connecting')
                  : project.bound
                    ? t('action.reconnect')
                    : t('action.connect'),
              )
            : null,
        );
      };

      const installState = install
        ? install.installed
          ? t('field.install.ok', { version: install.version || '' }) +
            (install.recordReadable === false ? ' (' + t('field.install.launcher') + ')' : '')
          : t('field.install.missing')
        : t('field.install.missing');

      const daemonState = daemonUp
        ? t('field.daemon.up', { port: (data.daemon && data.daemon.port) || '' }) +
          (data.daemon.portSource === 'discovered' ? ' (' + t('field.daemon.discovered') + ')' : '')
        : t('field.daemon.down', { port: (data && data.daemon && data.daemon.port) || '' });

      const boundState = bound
        ? t('field.bound.some', { name: bound.name, count: bound.tools ? bound.tools.length : 0 }) +
          (bound.bindingMode === 'env' ? ' (' + t('field.bound.viaEnv') + ')' : '')
        : t('field.bound.none');

      const body = h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h(
            Button,
            { variant: 'primary', size: 'sm', disabled: busy !== null, onClick: () => run('auto', '/bind', { auto: true }) },
            busy === 'auto' ? t('busy.connecting') : t('action.follow'),
          ),
          h(
            Button,
            { variant: 'outline', size: 'sm', disabled: busy !== null, onClick: () => run('scan', '/scan', {}) },
            busy === 'scan' ? t('busy.scanning') : t('action.rescan'),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: busy !== null || !bound,
              onClick: () => run('unbind', '/unbind', {}),
            },
            t('action.disconnect'),
          ),
        ),
        message ? h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: 0.85 } }, message) : null,
        state.error
          ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: '#f85149' } }, t('status.readFailed', { error: state.error }))
          : null,

        h('div', { style: sectionTitleStyle }, t('section.environment')),
        h(
          'div',
          { style: { fontSize: '12px', lineHeight: '20px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', null, t('field.install', { state: installState })),
            h(
              Button,
              { variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: () => run('update', '/update', {}) },
              busy === 'update' ? t('busy.checking') : t('action.checkUpdates'),
            ),
          ),
          updateLine(data ? data.update : null, t),
          h('div', null, t('field.daemon', { state: daemonState })),
          h('div', null, t('field.bound', { state: boundState })),
          h(
            'div',
            { style: mutedStyle },
            t('field.roots', {
              roots: data && data.roots && data.roots.length > 0 ? data.roots.join(', ') : t('field.roots.none'),
            }),
          ),
        ),

        h('div', { style: sectionTitleStyle }, t('section.editors', { count: editors.length })),
        editors.length === 0
          ? h('div', { style: mutedStyle }, t('group.noEditors'))
          : editors.map((editor) =>
              h(
                'div',
                { key: 'editor-' + editor.pid, style: rowStyle },
                h(StateDot, { state: 'ongoing' }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h(
                    'div',
                    null,
                    (editor.project || t('editor.unknownProject')) + (editor.scene ? ' · ' + editor.scene : ''),
                  ),
                  h('div', { style: mutedStyle }, 'pid ' + editor.pid + (editor.projectPath ? ' · ' + editor.projectPath : '')),
                ),
              ),
            ),

        h('div', { style: sectionTitleStyle }, t('section.registry', { count: projects.length })),
        h('div', { style: groupHeaderStyle }, t('group.bindable', { count: bindable.length })),
        bindable.length === 0
          ? h('div', { style: mutedStyle }, t('group.noBindable'))
          : bindable.map(projectRow),
        h(
          'div',
          { style: Object.assign({}, groupHeaderStyle, { display: 'flex', alignItems: 'center', gap: '8px' }) },
          h('span', null, t('group.unbindable', { count: unbindable.length })),
          unbindable.length === 0
            ? null
            : h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => setOthersCollapsed(!othersCollapsed) },
                othersCollapsed ? t('action.expand') : t('action.collapse'),
              ),
        ),
        // Collapsed by default: these projects cannot be bound until the addon
        // is installed, so they stay out of the way.
        othersCollapsed ? null : unbindable.map(projectRow),
      );

      const modal = h(
        Modal,
        {
          open: true,
          onClose: () => setOpen(false),
          title: t('modal.title'),
          closeLabel: t('modal.close'),
          description: t('modal.description', { seconds: POLL_MS / 1000 }),
          footer: h(Button, { variant: 'ghost', size: 'sm', onClick: () => setOpen(false) }, t('modal.close')),
        },
        body,
      );

      return h(React.Fragment, null, trigger, modal);
    }

    // Both services this bundle reads through `ctx`. `locale` is read in useLocale
    // and activeLocale, and cordis throws "cannot get property ... without inject"
    // for any service a plugin touches without declaring it here. Omitting it made
    // the component throw on its first render, which the slot system absorbs into a
    // crashed entry: the panel never appeared and only the browser console said so.
    // Every built-in that reads ctx.locale declares it (ui-sidebar, ui-cordis).
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      // `inject` waits for the slot to be declared, so registration order against
      // the sidebar package never matters. The context travels to the component
      // through the register inject face, which is how it reads the locale.
      ctx.slots.inject('sidebar.footer.action', function* () {
        yield ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'fennara-panel', inject: () => ({ clientCtx: ctx }) },
          FennaraAction,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test-only surface: the self-test asserts both tables stay in step.
    exports.__texts = TEXTS;
    return module.exports;
  },
});
