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

    /** Render the remembered release-check result: a line, never a request. */
    function updateLine(update) {
      if (!update) return null;
      const wrap = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' };
      if (update.ok !== true) {
        return h('div', { style: Object.assign({}, wrap, { color: '#f85149' }) }, '更新检查失败：' + (update.error || '未知错误'));
      }
      const parts = [];
      if (update.upToDate === true) parts.push('GitHub 上已是最新（' + update.latestVersion + '）');
      else if (update.upToDate === false)
        parts.push('发现新版本 ' + update.latestVersion + '（本地 ' + (update.localVersion || '未知') + '）');
      else parts.push('最新发布 ' + update.latestVersion + '，无法与本地版本比较');

      const children = [h('span', null, parts.join(''))];
      if (update.upToDate === false && update.releaseUrl) {
        children.push(
          h(
            'a',
            { href: update.releaseUrl, target: '_blank', rel: 'noreferrer' },
            '打开发布页',
          ),
        );
      }
      const stale = Array.isArray(update.staleProjects) ? update.staleProjects : [];
      if (stale.length > 0) {
        children.push(
          h(
            'span',
            { style: mutedStyle },
            '· ' + stale.length + ' 个工程的 addon 落后：' + stale.map((item) => item.name + ' ' + item.version).join('、'),
          ),
        );
      }
      return h('div', { style: wrap }, children);
    }

    function FennaraAction(props) {
      const wide = props.wide !== false;
      const [state, setState] = useStatus();
      const [open, setOpen] = React.useState(false);
      const [othersCollapsed, setOthersCollapsed] = React.useState(OTHERS_START_COLLAPSED);
      const [busy, setBusy] = React.useState(null);
      const [message, setMessage] = React.useState(null);

      const data = state.data;
      const bound = data && data.bound;
      const daemonUp = Boolean(data && data.daemon && data.daemon.reachable);
      const dotState = !data ? 'warning' : daemonUp ? (bound ? 'done' : 'ongoing') : 'error';
      const label = bound ? 'Fennara · ' + bound.name : daemonUp ? 'Fennara' : 'Fennara 离线';

      async function run(name, path, body) {
        setBusy(name);
        setMessage(null);
        try {
          const result = await call(path, body);
          if (result && result.status) setState({ loading: false, error: null, data: result.status });
          const parts = [];
          if (result && result.message) parts.push(result.message);
          if (result && Array.isArray(result.tools) && result.tools.length > 0) parts.push(result.tools.length + ' 个工具');
          if (result && result.ok === false) parts.unshift('失败：');
          setMessage(parts.join(' · ') || '完成');
        } catch (error) {
          setMessage('请求失败：' + String((error && error.message) || error));
        } finally {
          setBusy(null);
        }
      }

      const trigger = h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          title: 'Fennara · Godot',
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

      // One row renderer for both groups; only a bindable project gets the button.
      const projectRow = (project) =>
        h(
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
                : h(Pill, null, '无 addon'),
              project.running ? h(Pill, { active: true }, '运行中') : null,
              project.bound ? h(Pill, { active: true }, '已绑定') : null,
            ),
            h(
              'div',
              { style: mutedStyle },
              project.path + (project.lastUsedLabel ? ' · 最近使用：' + project.lastUsedLabel : ''),
            ),
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
                busy === 'bind-' + project.name ? '绑定中…' : project.bound ? '重新绑定' : '绑定',
              )
            : null,
        );

      const body = h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h(
            Button,
            {
              variant: 'primary',
              size: 'sm',
              disabled: busy !== null,
              onClick: () => run('auto', '/bind', { auto: true }),
            },
            busy === 'auto' ? '绑定中…' : '跟随当前编辑器',
          ),
          h(
            Button,
            { variant: 'outline', size: 'sm', disabled: busy !== null, onClick: () => run('scan', '/scan', {}) },
            busy === 'scan' ? '扫描中…' : '重新扫描',
          ),
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: busy !== null || !bound,
              onClick: () => run('unbind', '/unbind', {}),
            },
            '断开绑定',
          ),
        ),
        message ? h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: 0.85 } }, message) : null,
        state.error ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: '#f85149' } }, '状态读取失败：' + state.error) : null,

        h('div', { style: sectionTitleStyle }, '运行环境'),
        h(
          'div',
          { style: { fontSize: '12px', lineHeight: '20px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h(
              'span',
              null,
              'Fennara：' +
                (data && data.install && data.install.installed ? '已安装 ' + (data.install.version || '') : '未找到') +
                (data && data.install && data.install.installed && data.install.recordReadable === false
                  ? '（current.json 不可读，走启动器）'
                  : ''),
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: busy !== null,
                onClick: () => run('update', '/update', {}),
              },
              busy === 'update' ? '检查中…' : '检查更新',
            ),
          ),
          updateLine(data ? data.update : null),
          h(
            'div',
            null,
            'daemon：' +
              (daemonUp
                ? '已连接（端口 ' + (data.daemon.port || '') + '）' +
                  (data.daemon.portSource === 'discovered' ? ' · 自动发现' : '')
                : '未连接（端口 ' + ((data && data.daemon && data.daemon.port) || '') + '）'),
          ),
          h(
            'div',
            null,
            '当前绑定：' +
              (bound
                ? bound.name +
                  '（' + (bound.tools ? bound.tools.length : 0) + ' 个工具' +
                  (bound.bindingMode === 'env' ? ' · 经环境变量兜底' : '') +
                  '）'
                : '无'),
          ),
          h('div', { style: mutedStyle }, '扫描根：' + ((data && data.roots && data.roots.join('、')) || '未配置')),
        ),

        h('div', { style: sectionTitleStyle }, '运行中的 Godot 编辑器（' + editors.length + '）'),
        editors.length === 0
          ? h('div', { style: mutedStyle }, '未检测到正在运行的 Godot 编辑器')
          : editors.map((editor) =>
              h(
                'div',
                { key: 'editor-' + editor.pid, style: rowStyle },
                h(StateDot, { state: 'ongoing' }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', null, (editor.project || '未知工程') + (editor.scene ? ' · ' + editor.scene : '')),
                  h('div', { style: mutedStyle }, 'pid ' + editor.pid + (editor.projectPath ? ' · ' + editor.projectPath : '')),
                ),
              ),
            ),

        h('div', { style: sectionTitleStyle }, '工程仓库（' + projects.length + '）· 按最近使用排序'),
        h('div', { style: groupHeaderStyle }, '可绑定 · 含 Fennara addon（' + bindable.length + '）'),
        bindable.length === 0
          ? h('div', { style: mutedStyle }, '没有已装 Fennara addon 的工程')
          : bindable.map(projectRow),
        h(
          'div',
          { style: Object.assign({}, groupHeaderStyle, { display: 'flex', alignItems: 'center', gap: '8px' }) },
          h('span', null, '不可绑定 · 无 Fennara addon（' + unbindable.length + '）'),
          unbindable.length === 0
            ? null
            : h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => setOthersCollapsed(!othersCollapsed) },
                othersCollapsed ? '展开' : '收起',
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
          title: 'Fennara · Godot 连接',
          closeLabel: '关闭',
          description: '实时状态每 ' + POLL_MS / 1000 + ' 秒刷新一次',
          footer: h(Button, { variant: 'ghost', size: 'sm', onClick: () => setOpen(false) }, '关闭'),
        },
        body,
      );

      return h(React.Fragment, null, trigger, modal);
    }

    const inject = ['slots'];

    function apply(ctx) {
      // `inject` waits for the slot to be declared, so registration order against
      // the sidebar package never matters.
      ctx.slots.inject('sidebar.footer.action', function* () {
        yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'fennara-panel' }, FennaraAction);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
