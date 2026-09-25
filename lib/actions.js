/**
 * Shared operations behind both the model-facing tools and the sidebar panel.
 *
 * Keeping one implementation means the GUI button and the tool call can never
 * disagree about what "bind" or "scan" means.
 *
 * @module dsh-plugin-fennara/actions
 */

import { isBehind } from './update.js';

/**
 * Projects whose bundled addon is older than the installed Fennara runtime.
 * The update check reports these, because updating Fennara does not by itself
 * refresh the addon already copied into a project.
 */
function staleAddons(projects, localVersion) {
  if (typeof localVersion !== 'string' || localVersion === '') return [];
  return projects
    .filter(
      (project) =>
        project.hasFennaraAddon === true &&
        typeof project.fennaraVersion === 'string' &&
        isBehind(project.fennaraVersion, localVersion),
    )
    .map((project) => ({ name: project.name, path: project.path, version: project.fennaraVersion }));
}

/**
 * Compact relative age for display. Returns null when the time is unknown, so
 * callers can omit the field rather than render "从未".
 * @param {number|null} at epoch milliseconds
 * @param {number} [now]
 */
export function formatAge(at, now = Date.now()) {
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days} 天前`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} 个月前`;
  return `${Math.round(months / 12)} 年前`;
}

/**
 * Decorate registry records with live flags derived from the runtime snapshot,
 * plus the recency labels the panel and the tools display.
 */
function decorate(projects, snapshot, bound, now = Date.now()) {
  const runningPaths = new Set(snapshot.editors.map((editor) => editor.projectPath?.toLowerCase()).filter(Boolean));
  const runningNames = new Set(snapshot.editors.map((editor) => editor.project?.toLowerCase()).filter(Boolean));
  const boundPath = bound === null ? null : bound.path.toLowerCase();
  return projects.map((project) => ({
    ...project,
    running: runningPaths.has(project.path.toLowerCase()) || runningNames.has(project.name.toLowerCase()),
    bound: boundPath !== null && project.path.toLowerCase() === boundPath,
    lastUsedLabel: formatAge(project.sortAt > 0 ? project.sortAt : null, now),
    boundLabel: formatAge(project.lastUsedAt, now),
    recentLabel: formatAge(project.recentAt, now),
  }));
}

/**
 * Build the operation set over one runtime facade.
 * @param {object} runtime facade created by the plugin entry
 */
export function buildActions(runtime) {
  /** Current state of everything the panel and the tools report. */
  async function status(options = {}) {
    await runtime.ensureReady();
    const projects = await runtime.registry.list({ force: options.refresh === true });
    const snapshot = await runtime.snapshot(options);
    const boundProject = runtime.binder.current();
    const install = runtime.install();
    return {
      ok: true,
      ts: Date.now(),
      install: {
        installed: install?.installed === true,
        version: install?.version ?? null,
        appDir: install?.appDir ?? null,
        mcpRuntime: install?.mcpRuntime ?? null,
        command: runtime.command(),
      },
      daemon: snapshot.daemon,
      editors: snapshot.editors,
      processProbe: snapshot.processProbe,
      projects: decorate(projects, snapshot, boundProject),
      bound:
        boundProject === null
          ? null
          : {
              name: boundProject.name,
              path: boundProject.path,
              serverName: runtime.binder.binding?.serverName ?? null,
              bindingMode: runtime.binder.binding?.mode ?? null,
              tools: runtime.binder.bridgedTools(runtime.binder.binding?.serverName ?? ''),
            },
      roots: [...runtime.registry.roots],
      update: runtime.updates?.last() ?? null,
      settings: {
        autoBind: runtime.settings.autoBind !== false,
        toolCallTimeoutMs: runtime.settings.toolCallTimeoutMs,
        daemonPort: runtime.settings.daemonPort,
        maxDepth: runtime.registry.maxDepth,
        nestedDepth: runtime.registry.nestedDepth,
        usageFile: runtime.usage?.file ?? null,
      },
    };
  }

  /** Rescan the configured (or supplied) roots. */
  async function scan(options = {}) {
    const roots =
      Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : runtime.registry.roots;
    if (Number.isInteger(options.maxDepth)) runtime.registry.maxDepth = options.maxDepth;
    const projects = await runtime.registry.refresh({ roots });
    return {
      ok: true,
      message: `扫描完成：${projects.length} 个 Godot 工程`,
      count: projects.length,
      roots,
      depth: runtime.registry.maxDepth,
      projects,
    };
  }

  /**
   * Attach one project, following the running editor when `auto` is set.
   * `code` lets each caller phrase the same failure for its own audience.
   * @returns {Promise<object>}
   */
  async function bind(options = {}) {
    let target = null;
    let source = 'registry';

    if (options.auto === true) {
      const snapshot = await runtime.snapshot({ fresh: true });
      if (snapshot.editors.length === 0) {
        return { ok: false, code: 'no_editor', message: '没有检测到正在运行的 Godot 编辑器，请先打开工程。' };
      }
      if (snapshot.editors.length > 1) {
        const names = snapshot.editors.map((editor) => editor.project ?? `pid ${editor.pid}`).join('、');
        return { ok: false, code: 'ambiguous', message: `检测到多个 Godot 编辑器（${names}），请指定工程。`, editors: snapshot.editors };
      }
      const editor = snapshot.editors[0];
      if (editor.projectPath) target = await runtime.registry.resolve(editor.projectPath);
      if (target === null && editor.project) {
        target = await runtime.registry.resolve(editor.project);
        if (target === null) {
          await runtime.registry.refresh({});
          target = await runtime.registry.resolve(editor.project);
        }
      }
      source = 'running editor';
      if (target === null) {
        return {
          ok: false,
          code: 'not_found',
          message: `编辑器打开的是 ${editor.project ?? '未知工程'}，但它不在仓库里；先扫描其所在目录。`,
          editor,
        };
      }
    } else if (typeof options.project === 'string' && options.project.trim() !== '') {
      target = await runtime.registry.resolve(options.project);
      if (target === null) {
        await runtime.registry.refresh({});
        target = await runtime.registry.resolve(options.project);
      }
      if (target === null) {
        return { ok: false, code: 'not_found', message: `仓库里没有匹配 "${options.project}" 的工程。`, query: options.project };
      }
    } else {
      return { ok: false, code: 'bad_request', message: '需要 project（名字或路径）或 auto。' };
    }

    if (!target.hasFennaraAddon) {
      return {
        ok: false,
        code: 'no_addon',
        message: `${target.name} 没有安装 Fennara addon。可运行：fennara install --project "${target.path}"`,
        project: target,
      };
    }
    await runtime.ensureReady();
    if (runtime.command() === null) {
      return { ok: false, code: 'no_launcher', message: '找不到 Fennara MCP 启动器，请先安装或修复 Fennara。' };
    }
    try {
      const result = await runtime.binder.bind(target);
      // A successful bind is the only trustworthy "this project was used"
      // signal; the registry orders by it ahead of the filesystem guess.
      await runtime.usage?.record(target.path);
      return {
        ok: true,
        message: `已绑定 ${target.name}（${source === 'running editor' ? '跟随编辑器' : '按名指定'}）`,
        project: target,
        source,
        serverName: result.serverName,
        bindingMode: result.mode,
        tools: result.tools,
        replaced: result.replaced?.name ?? null,
      };
    } catch (error) {
      return { ok: false, code: 'bind_failed', message: `绑定失败：${error?.message ?? String(error)}`, project: target };
    }
  }

  /** Release the active binding. */
  async function unbind() {
    const released = await runtime.binder.unbind();
    return released === null
      ? { ok: true, message: '当前没有绑定。' }
      : { ok: true, message: `已断开 ${released.name}`, released: released.name };
  }

  /**
   * Look up the newest published release and compare it with what is installed.
   * The only action here that leaves the machine; every failure comes back as
   * `{ ok: false, error }` rather than a throw.
   */
  async function checkUpdate(options = {}) {
    await runtime.ensureReady();
    if (runtime.updates === null || runtime.updates === undefined) {
      return { ok: false, message: '更新检查不可用（插件未装配更新检查器）', error: 'updates-unavailable' };
    }
    const projects = await runtime.registry.list();
    const install = runtime.install();
    const result = await runtime.updates.check({
      localVersion: install?.version ?? null,
      staleProjects: staleAddons(projects, install?.version ?? null),
      force: options.force === true,
    });
    return {
      ...result,
      message: result.ok === true ? describeUpdate(result) : `检查更新失败：${result.error}`,
    };
  }

  /** One sentence a panel label or a tool line can use directly. */
  function describeUpdate(result) {
    if (result.upToDate === true) return `已是最新版本（${result.latestVersion}）`;
    if (result.upToDate === false) return `发现新版本 ${result.latestVersion}（本地 ${result.localVersion ?? '未知'}）`;
    return `最新发布为 ${result.latestVersion}，无法与本地版本比较`;
  }

  return { status, scan, bind, unbind, checkUpdate, describeUpdate };
}
