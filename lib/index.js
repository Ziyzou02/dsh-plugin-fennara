/**
 * dsh-plugin-fennara — attach Godot projects to DSH through the Fennara bridge.
 *
 * Three responsibilities:
 *   1. a project registry (which Godot projects exist, and where),
 *   2. a runtime probe (which editor is running right now, is the daemon up),
 *   3. an on-demand binder (attach exactly one project, release the previous).
 *
 * The heavy Fennara tool surface is not owned here: the binder starts DSH's own
 * `@deepseek-ai/dsh-mcp-client` per attached project, so this plugin stays
 * small and inherits the maintained MCP behaviour.
 *
 * @module dsh-plugin-fennara
 */

import { ProjectRegistry, resolveFennaraInstall, resolveMcpCommand, rootsFromGodotEditor } from './registry.js';
import { listGodotProcesses, daemonHealth, discoverDaemonPort, DEFAULT_DAEMON_PORT } from './probe.js';
import { FennaraBinder } from './binder.js';
import { buildActions } from './actions.js';
import { buildTools } from './tools.js';
import { registerFennaraRoutes } from './webapi.js';
import { UsageStore, defaultUsageFile } from './usage.js';
import { UpdateChecker, DEFAULT_REPO } from './update.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fennara';

/** Services required by this plugin. */
export const inject = ['tools'];

function normalizeConfig(config) {
  const settings = {
    roots: [],
    maxDepth: 4,
    nestedDepth: 2,
    ttlMs: 60_000,
    // Off by default: auto-binding costs the attached project's whole tool set
    // in every request, so attaching is an explicit action (panel button, tool
    // call, or opting in here).
    autoBind: false,
    daemonPort: DEFAULT_DAEMON_PORT,
    toolCallTimeoutMs: 300_000,
    mcpClientModule: null,
    usageFile: null,
    // Release check: on demand only, so the timeout and the cache exist to
    // avoid repeating a request the user just made.
    githubRepo: DEFAULT_REPO,
    githubToken: null,
    updateTimeoutMs: 8_000,
    updateCacheTtlMs: 300_000,
    // The process listing spawns PowerShell, so it is cached far longer than the
    // loopback daemon check that a live panel polls continuously.
    processProbeTtlMs: 15_000,
    processProbeTimeoutMs: 15_000,
    daemonProbeTtlMs: 1_000,
    daemonTimeoutMs: 1_500,
    ...(config ?? {}),
  };
  if (!Array.isArray(settings.roots)) settings.roots = settings.roots ? [settings.roots] : [];
  return settings;
}

/**
 * Live instances of this plugin in the process.
 *
 * A profile can compose the `fennara` row twice. The easy way to do it by
 * accident is adding an `insert:` entry for an id a bundle layer already
 * declared: `insert` appends, so it adds a SECOND row instead of changing the
 * first, and the second instance then tries to register the same tool names.
 * That failure is opaque, and a rejected plugin activation can abort the boot.
 *
 * So the second instance declines to mount and says what to fix. It does not
 * throw, deliberately: a misconfigured row should degrade to one working
 * instance plus a loud diagnostic, never to a harness that will not start.
 */
let activeInstances = 0;

const DUPLICATE_MESSAGE = [
  'fennara: refusing to mount a second instance — this profile composes the "fennara" row twice.',
  'A patch entry that uses `insert:` for an already-declared row APPENDS a duplicate; to change an',
  'existing row, target it by id instead: `- id: fennara` followed by `config: {...}`.',
  'Note that an id-targeted patch replaces that row\'s whole config, so restate every field you still want.',
  'The first instance stays active; remove the duplicate entry and restart dsh.',
].join(' ');

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] profile config for this plugin
 */
export function apply(ctx, config) {
  if (activeInstances > 0) {
    ctx.logger?.error?.(DUPLICATE_MESSAGE);
    return;
  }
  activeInstances += 1;
  const settings = normalizeConfig(config);
  const logger = ctx.logger ?? console;
  // Release the slot on teardown so a reload can mount again.
  ctx.effect?.(() => () => {
    activeInstances = Math.max(0, activeInstances - 1);
  }, 'fennara.instance');
  // Recency is what orders the registry, and only this plugin knows when a
  // project was actually bound, so the record is persisted across restarts.
  const usage = new UsageStore({ file: settings.usageFile ?? defaultUsageFile(), logger });
  const registry = new ProjectRegistry({
    roots: settings.roots,
    maxDepth: settings.maxDepth,
    nestedDepth: settings.nestedDepth,
    ttlMs: settings.ttlMs,
    usage,
  });

  const state = {
    install: null,
    command: null,
    rootsFromEditor: [],
    rootSource: 'config',
    daemonPort: null,
    daemonPortSource: null,
  };
  const binder = new FennaraBinder(ctx, {
    command: null,
    toolCallTimeoutMs: settings.toolCallTimeoutMs,
    mcpClientModule: settings.mcpClientModule,
    logger,
  });
  const updates = new UpdateChecker({
    repo: settings.githubRepo,
    token: settings.githubToken,
    timeoutMs: settings.updateTimeoutMs,
    cacheTtlMs: settings.updateCacheTtlMs,
    logger,
  });

  /** Read Fennara's install record, the spawn command, and the usage record. */
  async function ensureInstall() {
    try {
      state.install = await resolveFennaraInstall();
    } catch (error) {
      logger.warn?.(`fennara: install discovery failed: ${error?.message ?? error}`);
      state.install = null;
    }
    if (state.command === null && state.install !== null) {
      const resolved = resolveMcpCommand(state.install);
      state.command = resolved.command;
      binder.command = resolved.command;
    }
    // Cheap after the first call, and required before any registry read so the
    // recency ordering sees the persisted history rather than an empty store.
    await usage.load();
    // With no configured roots, fall back to the projects Godot's editor knows.
    if (registry.roots.length === 0 && state.rootsFromEditor.length === 0) {
      try {
        state.rootsFromEditor = await rootsFromGodotEditor();
        state.rootSource = 'godot-editor';
        for (const root of state.rootsFromEditor) registry.roots.push(root);
      } catch {
        /* no editor registry; the model can still call fennara_search with roots */
      }
    }
    return state.install;
  }

  // The two halves of the probe have very different costs: the daemon check is
  // one loopback HTTP request, while the process listing spawns PowerShell. A
  // live panel polls continuously, so they get separate caches and only the
  // cheap half is refreshed on every poll.
  let processCache = null;
  let processAt = 0;
  let processInFlight = null;
  let daemonCache = null;
  let daemonAt = 0;

  function refreshProcesses() {
    if (processInFlight === null) {
      processInFlight = listGodotProcesses({ timeoutMs: settings.processProbeTimeoutMs })
        .then((result) => {
          processCache = result;
          processAt = Date.now();
          return result;
        })
        .catch((error) => {
          logger.warn?.(`fennara: process probe failed: ${error?.message ?? error}`);
          processCache = { supported: false, editors: [], processes: [], note: 'probe failed' };
          processAt = Date.now();
          return processCache;
        })
        .finally(() => {
          processInFlight = null;
        });
    }
    return processInFlight;
  }

  async function refreshDaemon() {
    const configured = state.daemonPort ?? settings.daemonPort;
    let result = await daemonHealth({ port: configured, timeoutMs: settings.daemonTimeoutMs });
    if (!result.reachable) {
      // The port is a compiled-in default on both sides, so the daemon's own
      // startup log is the only place a real one is written down. Binding is
      // unaffected either way; this keeps the status honest if it ever moves.
      const discovered = await discoverDaemonPort(state.install?.appDir);
      if (discovered !== null && discovered !== configured) {
        const retry = await daemonHealth({ port: discovered, timeoutMs: settings.daemonTimeoutMs });
        if (retry.reachable) {
          logger.info?.(`fennara: daemon found on discovered port ${discovered} (configured ${configured})`);
          state.daemonPort = discovered;
          state.daemonPortSource = 'discovered';
          result = retry;
        }
      }
    }
    daemonCache = {
      ...result,
      configuredPort: settings.daemonPort,
      portSource: state.daemonPortSource ?? 'configured',
    };
    daemonAt = Date.now();
    return daemonCache;
  }

  /** Runtime snapshot: running editors + daemon health, each cached on its own TTL. */
  async function snapshot(options = {}) {
    await ensureInstall();
    const now = Date.now();
    const fresh = options.fresh === true;
    const wantProcesses = fresh || processCache === null || now - processAt > settings.processProbeTtlMs;
    const wantDaemon = fresh || daemonCache === null || now - daemonAt > settings.daemonProbeTtlMs;
    const [processes, daemon] = await Promise.all([
      wantProcesses ? refreshProcesses() : Promise.resolve(processCache),
      wantDaemon ? refreshDaemon() : Promise.resolve(daemonCache),
    ]);
    return {
      probedAt: new Date().toISOString(),
      processProbe: { supported: processes.supported, note: processes.note ?? null },
      editors: processes.editors,
      processes: processes.processes,
      daemon,
    };
  }

  const runtime = {
    registry,
    binder,
    settings,
    usage,
    updates,
    install: () => state.install,
    command: () => binder.command ?? state.command,
    snapshot,
    // Tools that need the spawn command must resolve the install record first;
    // without this a cold `fennara_use` would report the launcher as missing.
    ensureReady: ensureInstall,
  };
  const actions = buildActions(runtime);

  // The sidebar panel is optional infrastructure: a headless profile has no web
  // carrier, and that must not stop the tools from working.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const disposeRoutes = registerFennaraRoutes(webCtx, actions, logger);
      return () => disposeRoutes();
    });
  }

  // Registered through ctx.effect so teardown is deterministic: the disposers
  // run when this plugin's fiber is disposed, whatever the tool registry does
  // with its own effect scoping.
  const registerTools = () => buildTools(runtime, actions).map((definition) => ctx.tools.register(definition));
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const disposers = registerTools();
      logger.info?.(
        `fennara: plugin loaded — ${disposers.length} tools, roots=${
          registry.roots.length > 0 ? registry.roots.join(',') : '(discovering)'
        }`,
      );
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* already unregistered */
          }
        }
      };
    }, 'fennara.tools');

    // Release the active binding when this plugin (or the harness) tears down,
    // and make sure a debounced usage write is not lost.
    ctx.effect(() => () => {
      void binder.unbind();
      void usage.flush();
    }, 'fennara.binding');
  } else {
    registerTools();
  }

  /**
   * Attach the project of the running Godot editor, when exactly one is open.
   * Deliberately not awaited: a slow process probe must not delay harness boot.
   */
  async function autoBind() {
    try {
      await ensureInstall();
      if (binder.command === null) {
        logger.info?.('fennara: auto-bind skipped — the Fennara MCP launcher was not found');
        return;
      }
      const current = await snapshot({ fresh: true });
      if (current.editors.length !== 1) {
        logger.info?.(
          `fennara: auto-bind skipped — ${current.editors.length} Godot editor(s) running (bind explicitly with fennara_use)`,
        );
        return;
      }
      const editor = current.editors[0];
      let project = editor.projectPath ? await registry.resolve(editor.projectPath) : null;
      if (project === null && editor.project) {
        await registry.refresh({});
        project = await registry.resolve(editor.project);
      }
      if (project === null) {
        logger.info?.(`fennara: auto-bind skipped — ${editor.project ?? 'the running editor'} is not in the registry`);
        return;
      }
      if (!project.hasFennaraAddon) {
        logger.info?.(`fennara: auto-bind skipped — ${project.name} has no Fennara addon`);
        return;
      }
      const result = await binder.bind(project);
      logger.info?.(`fennara: auto-bound ${project.name} as ${result.serverName} (${result.tools.length} tools)`);
    } catch (error) {
      logger.warn?.(`fennara: auto-bind failed: ${error?.message ?? error}`);
    }
  }

  if (settings.autoBind !== false) void autoBind();
}
