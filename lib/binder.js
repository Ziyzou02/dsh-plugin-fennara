/**
 * Binder: attach one Godot project to the Fennara MCP server, on demand.
 *
 * Each binding is one `@deepseek-ai/dsh-mcp-client` instance — the bridge DSH
 * already ships — started in this plugin's own context as a disposable fiber,
 * so switching projects disposes the previous connection (and its child
 * process) instead of accumulating them.
 *
 * The bridge module is resolved through the profile base URL at runtime rather
 * than imported statically, so this package works from any install location
 * (npm, file:, link:) and reuses DSH's maintained reconnect/timeout/image
 * handling instead of duplicating it.
 *
 * @module dsh-plugin-fennara/binder
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Bridge package that publishes MCP tools as `mcp__<serverName>__<tool>`. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** Tool names are prefixed with this by the bridge; we use it to enumerate ours. */
export function bridgedPrefix(serverName) {
  return `mcp__${serverName}__`;
}

/** Namespace rules from the bridge: `[A-Za-z0-9_-]{1,32}`, unique per scope. */
export function serverNameForProject(project) {
  const base = (project.dirName || project.name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `fennara-${base || 'project'}`;
}

function resolveSpecifier(specifier, anchors) {
  const candidates = anchors.filter((value) => typeof value === 'string' && value.length > 0);
  candidates.push(import.meta.url);
  let lastError;
  for (const anchor of candidates) {
    try {
      return createRequire(anchor).resolve(specifier);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${MCP_CLIENT_PACKAGE} could not be resolved (tried ${candidates.join(', ')}): ${lastError?.message ?? 'unknown error'}. ` +
      'Set `mcpClientModule` in this plugin\'s config to the absolute path of the bridge module to override resolution.',
  );
}

/**
 * Resolve the bridge package the same way `FennaraBinder` does.
 * Exported so the self-test can prove the profile really provides it.
 * @param {string} [baseUrl] DSH profile base URL (usually `ctx.baseUrl`)
 * @returns {string} absolute path of the bridge module
 */
export function resolveBridgeModule(baseUrl) {
  return resolveSpecifier(MCP_CLIENT_PACKAGE, [baseUrl]);
}

/** Binds and unbinds Fennara MCP servers for this plugin instance. */
export class FennaraBinder {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{command: string, toolCallTimeoutMs?: number, mcpClientModule?: string, logger?: object}} options
   */
  constructor(ctx, options) {
    this.ctx = ctx;
    this.command = options.command;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 300_000;
    this.mcpClientModule = options.mcpClientModule ?? null;
    this.logger = options.logger ?? ctx.logger;
    /** @type {{project: object, serverName: string, fiber: any}|null} */
    this.binding = null;
    this.modulePromise = null;
  }

  async loadBridge() {
    if (this.modulePromise === null) {
      // The plugin may be installed anywhere (`link:` installs resolve to their
      // source path), so the bridge is never a static import: it is resolved
      // through the profile base URL the loader publishes on the context.
      const resolved =
        this.mcpClientModule ??
        resolveSpecifier(MCP_CLIENT_PACKAGE, [this.ctx.baseUrl, this.ctx.root?.baseUrl]);
      this.modulePromise = import(pathToFileURL(resolved).href).catch((error) => {
        this.modulePromise = null;
        throw error;
      });
    }
    return this.modulePromise;
  }

  /** The project currently bound, or null. */
  current() {
    return this.binding === null ? null : this.binding.project;
  }

  /** Tool names the bridge published for one server namespace. */
  bridgedTools(serverName) {
    const prefix = bridgedPrefix(serverName);
    let schemas = [];
    try {
      schemas = this.ctx.tools?.schemas?.() ?? [];
    } catch {
      return [];
    }
    return schemas.map((schema) => schema.name).filter((name) => typeof name === 'string' && name.startsWith(prefix));
  }

  /**
   * Start one bridge fiber, disposing it again when activation fails.
   *
   * Returns the fiber inside a plain object on purpose: `ctx.plugin()` hands
   * back a thenable, and an async method that returned it directly would let
   * the caller's `await` unwrap it a second time — yielding the plugin body's
   * return value instead of the fiber, which silently breaks disposal.
   */
  async #start(bridge, config) {
    const fiber = this.ctx.plugin(bridge, config);
    try {
      await fiber;
    } catch (error) {
      try {
        await fiber.dispose?.();
      } catch {
        /* the failed fiber is already gone */
      }
      throw error;
    }
    return { fiber };
  }

  /**
   * Bind one project, replacing any existing binding.
   * @param {object} project registry record with `path`
   * @param {{exclusive?: boolean}} [options]
   * @returns {Promise<{serverName: string, tools: string[], replaced: object|null, mode: string}>}
   */
  async bind(project, options = {}) {
    if (!project || typeof project.path !== 'string') throw new Error('bind requires a project record with a path');
    const replaced = options.exclusive === false ? null : this.current();
    if (options.exclusive !== false) await this.unbind();

    const bridge = await this.loadBridge();
    const serverName = serverNameForProject(project);
    const base = {
      serverName,
      transport: 'stdio',
      command: this.command,
      toolCallTimeoutMs: this.toolCallTimeoutMs,
      failOnStartupError: true,
    };
    // The primary contract is the documented CLI flag. The environment variable
    // is a fallback Fennara accepts today, so a renamed or removed flag in a
    // future release costs one extra attempt instead of killing the plugin.
    const attempts = [
      { mode: 'cli', config: { ...base, args: ['--project-path', project.path] } },
      { mode: 'env', config: { ...base, args: [], env: { FENNARA_PROJECT_PATH: project.path } } },
    ];
    this.logger?.info?.(`fennara: binding ${project.name} (${project.path}) as ${serverName}`);
    const failures = [];
    for (const attempt of attempts) {
      try {
        const { fiber } = await this.#start(bridge, attempt.config);
        this.binding = { project, serverName, fiber, mode: attempt.mode };
        if (attempt.mode !== 'cli') {
          this.logger?.warn?.('fennara: --project-path was rejected; bound through FENNARA_PROJECT_PATH instead');
        }
        return { serverName, tools: this.bridgedTools(serverName), replaced, mode: attempt.mode };
      } catch (error) {
        failures.push({ mode: attempt.mode, error });
      }
    }
    const [first, second] = failures;
    throw new Error(
      `could not start the Fennara MCP server for ${project.name}: ${first?.error?.message ?? first?.error}` +
        (second ? ` (the FENNARA_PROJECT_PATH fallback also failed: ${second.error?.message ?? second.error})` : ''),
    );
  }

  /** Dispose the active binding (and its child process), if any. */
  async unbind() {
    const active = this.binding;
    if (active === null) return null;
    this.binding = null;
    this.logger?.info?.(`fennara: unbinding ${active.project.name}`);
    try {
      await active.fiber.dispose?.();
    } catch (error) {
      this.logger?.warn?.(`fennara: unbind of ${active.project.name} failed: ${error?.message ?? error}`);
    }
    return active.project;
  }
}
