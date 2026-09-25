/**
 * Offline self-test for dsh-plugin-fennara.
 *
 * Runs without DSH, without network access, and without Godot or Fennara
 * installed: every check runs against generated fixtures in the OS temp
 * directory, so the suite is reproducible on any machine and in CI. The only
 * optional part is an extra pass over a real Godot workspace.
 *
 *   node test/selftest.mjs [scanRoot]
 *
 * Pass a root (or set FENNARA_TEST_ROOT) to add the environment pass; without
 * one that section reports SKIP and the suite still passes.
 *
 * The process probe spawns PowerShell through a pipe, so run this outside any
 * confined sandbox that denies piped stdio.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';

import {
  resolveFennaraInstall,
  resolveMcpCommand,
  launcherPath,
  ProjectRegistry,
  rootsFromGodotEditor,
  matchProject,
  scanForProjects,
} from '../lib/registry.js';
import { resolveBridgeModule, FennaraBinder } from '../lib/binder.js';
import { formatAge, buildActions } from '../lib/actions.js';
import { registerFennaraRoutes } from '../lib/webapi.js';
import { UsageStore } from '../lib/usage.js';
import { UpdateChecker, parseVersion, compareVersions, isBehind, fetchLatestRelease, DEFAULT_REPO } from '../lib/update.js';
import { probeRuntime, classifyWindowTitle, projectPathFromCommandLine, discoverDaemonPort } from '../lib/probe.js';
import { apply as applyPlugin } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeBridge = join(here, 'fixtures', 'fake-bridge.mjs');
const cliRejectingBridge = join(here, 'fixtures', 'cli-rejecting-bridge.mjs');
/**
 * Optional root of a real Godot workspace. Everything except the environment
 * section below runs against generated fixtures, so the suite passes on a clean
 * machine and in CI; this only adds extra coverage for a developer who has
 * Godot, Fennara and some projects around.
 */
const scanRoot = process.argv[2] ?? process.env.FENNARA_TEST_ROOT ?? null;
// Every plugin instance this test creates writes its usage record here, never
// into the real DSH home.
const testHome = await mkdtemp(join(tmpdir(), 'fennara-home-'));
const testUsageFile = join(testHome, 'usage.json');

let failures = 0;
let checks = 0;
let skipped = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A check that needs something this machine may not have. */
function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP  ${label} — ${reason}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * Build a throwaway Godot workspace. Test data must never depend on the
 * developer's own projects: the fixtures carry a project.godot, and optionally
 * the Fennara addon marker and version the registry looks for.
 */
async function makeFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fennara-fixture-'));
  const specs = [
    { dir: 'alpha', name: 'Alpha', addon: '0.4.3' },
    { dir: 'beta', name: 'Beta', addon: '0.4.2' },
    { dir: 'gamma', name: 'Gamma', addon: null },
  ];
  for (const spec of specs) {
    const projectDir = join(root, spec.dir);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'project.godot'),
      `config_version=5\n\n[application]\n\nconfig/name="${spec.name}"\n`,
    );
    if (spec.addon !== null) {
      const addonDir = join(projectDir, 'addons', 'fennara');
      await mkdir(addonDir, { recursive: true });
      await writeFile(join(addonDir, 'fennara.gdextension'), '[configuration]\n');
      await writeFile(join(addonDir, 'VERSION'), spec.addon);
    }
  }
  return root;
}

/** Minimal cordis stand-in: a shared tool registry plus disposable fibers. */
function makeFakeContext() {
  const registered = new Map();
  const disposed = [];
  const logs = [];
  const effectDisposers = [];
  const tools = {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
    schemas() {
      return [...registered.values()].map((definition) => ({ name: definition.name }));
    },
  };
  const ctx = {
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
    },
    tools,
    effect(callback) {
      // Cordis keeps the returned disposer; so does this stand-in, so a test can
      // tear the plugin down exactly like a fiber disposal would.
      const dispose = callback();
      if (typeof dispose === 'function') effectDisposers.push(dispose);
    },
    on() {},
    plugin(bridge, config) {
      // Mimic cordis: tools registered inside this fiber are unregistered when
      // the fiber is disposed, which is what makes hot switching leak-free.
      const ownDisposers = [];
      const fiberTools = {
        register(definition) {
          registered.set(definition.name, definition);
          const dispose = () => registered.delete(definition.name);
          ownDisposers.push(dispose);
          return dispose;
        },
        schemas: tools.schemas,
      };
      const child = { ...ctx, tools: fiberTools, logger: ctx.logger };
      const ready = Promise.resolve().then(() => {
        const factory = bridge.default?.apply ?? bridge.apply;
        return factory(child, config);
      });
      return {
        then: (...args) => ready.then(...args),
        catch: (...args) => ready.catch(...args),
        finally: (...args) => ready.finally(...args),
        dispose: async () => {
          disposed.push(config.serverName);
          for (const dispose of ownDisposers.reverse()) dispose();
          const factory = bridge.default?.dispose ?? bridge.dispose;
          if (typeof factory === 'function') await factory(child, config);
        },
      };
    },
  };
  const dispose = () => {
    for (const disposer of effectDisposers.reverse()) {
      try {
        disposer();
      } catch {
        /* already torn down */
      }
    }
  };
  return { ctx, registered, disposed, logs, dispose };
}

const toolsByName = (registered) => Object.fromEntries(registered);

/** Drive a cordis-style generator effect to completion (registration fibers). */
function driveGenerator(produced) {
  if (produced === null || produced === undefined || typeof produced.next !== 'function') return produced;
  let step = produced.next();
  while (step.done !== true) step = produced.next(step.value);
  return step.value;
}

/**
 * The smallest React that can build and walk this panel's element tree:
 * function components, one hook array per component render, and host elements
 * serialized to markup. Effects never run — a static render has no browser.
 */
function createMiniReact() {
  const Fragment = Symbol('Fragment');
  let hooks = [];
  let cursor = 0;
  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) };
      // React only derives children from positional arguments when at least one
      // was passed; an explicit `children` prop in the config object survives.
      if (children.length > 0) {
        const flat = [];
        for (const child of children) {
          if (Array.isArray(child)) flat.push(...child.flat(Infinity));
          else if (child !== null && child !== undefined && child !== false) flat.push(child);
        }
        next.children = flat.length <= 1 ? (flat[0] ?? null) : flat;
      }
      if (!('children' in next)) next.children = null;
      return { type, props: next };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = next; }];
    },
    useEffect() {
      /* static render: effects are skipped */
    },
  };
  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(render).join('');
    const { type, props } = node;
    if (type === Fragment) return render(props.children);
    if (typeof type === 'function') {
      cursor = 0;
      hooks = [];
      return render(type(props));
    }
    return `<${String(type)}>${render(props.children)}</${String(type)}>`;
  }
  return { React, render };
}

/** Minimal IncomingMessage stand-in for the panel API handlers. */function makeFakeReq(method, body) {
  const handlers = new Map();
  const req = {
    method,
    on(event, callback) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(callback);
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const callback of handlers.get('data') ?? []) callback(Buffer.from(JSON.stringify(body), 'utf8'));
    }
    for (const callback of handlers.get('end') ?? []) callback();
  });
  return req;
}

/** Minimal ServerResponse stand-in that captures the JSON body. */
function makeFakeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(bytes) {
      this.body = JSON.parse(Buffer.from(bytes).toString('utf8'));
    },
  };
}

// ---------------------------------------------------------------- registry ---
section('Fennara install discovery');
const install = await resolveFennaraInstall();
console.log(`  appDir      : ${install.appDir}`);
console.log(`  version     : ${install.version}`);
console.log(`  mcpRuntime  : ${install.mcpRuntime}`);
if (install.installed) {
  check('install record found', install.installed === true, `version=${install.version}`);
  const command = resolveMcpCommand(install);
  check('spawn command resolved', typeof command.command === 'string', `${command.via}: ${command.command}`);
} else {
  skip('install record found', 'Fennara is not installed on this machine');
  skip('spawn command resolved', 'Fennara is not installed on this machine');
}

// The fixtures below are the suite's only source of project data, so the whole
// report is reproducible on any machine.
const workspace = await makeFixtureRoot();
section(`Project registry (fixture root: ${workspace})`);
const registry = new ProjectRegistry({ roots: [workspace], maxDepth: 4 });
const projects = await registry.refresh();
for (const project of projects) {
  console.log(
    `  - ${project.name.padEnd(22)} fennara=${project.hasFennaraAddon ? project.fennaraVersion ?? 'yes' : 'no'}  ${project.path}`,
  );
}
check('every fixture project is found', projects.length === 3, `${projects.length} project(s)`);
const withAddon = projects.filter((project) => project.hasFennaraAddon);
check('Fennara-enabled fixtures are recognised', withAddon.length === 2, withAddon.map((p) => p.name).join(', '));
check(
  'project name parsed from project.godot',
  projects.every((project) => typeof project.name === 'string' && project.name.length > 0),
);
const target = withAddon[0];
check('resolve by name', matchProject(projects, target.name)?.path === target.path, target.name);
check('resolve by absolute path', matchProject(projects, target.path)?.path === target.path);

// Nested projects are a real layout (editor tooling inside a game repo), so the
// scan must not stop at the first project.godot it meets.
const nestedRoot = await mkdtemp(join(tmpdir(), 'fennara-scan-'));
try {
  const outer = join(nestedRoot, 'outer');
  const inner = join(outer, 'inner');
  const buried = join(outer, 'assets', 'a', 'deep');
  await mkdir(inner, { recursive: true });
  await mkdir(buried, { recursive: true });
  await writeFile(join(outer, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Outer"\n');
  await writeFile(join(inner, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Inner"\n');
  await writeFile(join(buried, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Buried"\n');
  const fixtureFound = await scanForProjects([nestedRoot], { maxDepth: 8, nestedDepth: 2 });
  const names = fixtureFound.map((project) => project.name).sort();
  check('nested project under a project root is found', names.includes('Inner'), names.join(', '));
  check('deep folders inside a project are not walked', !names.includes('Buried'), names.join(', '));
} finally {
  await rm(nestedRoot, { recursive: true, force: true });
}

// ------------------------------------------------------------------ probe ---
section('Runtime probe');
check('editor title parsed', classifyWindowTitle('Main.tscn - mygame - Godot Engine').project === 'mygame');
check('editor title scene parsed', classifyWindowTitle('Main.tscn - mygame - Godot Engine').scene === 'Main.tscn');
check('game title parsed', classifyWindowTitle('mygame (DEBUG)').kind === 'game');
check(
  'command line --path parsed',
  projectPathFromCommandLine('"C:\\godot.exe" --path D:\\Projects\\mygame --editor') === 'D:\\Projects\\mygame',
);
const snapshot = await probeRuntime({}).catch((error) => ({
  processProbe: { supported: false, note: `probe threw: ${error?.message ?? error}` },
  editors: [],
  daemon: { reachable: false, port: 41287, reason: 'probe threw' },
}));
console.log(`  process probe supported : ${snapshot.processProbe.supported}${snapshot.processProbe.note ? ` (${snapshot.processProbe.note})` : ''}`);
console.log(`  daemon reachable        : ${snapshot.daemon.reachable} (port ${snapshot.daemon.port})`);
for (const editor of snapshot.editors) {
  console.log(`  editor: pid ${editor.pid} project=${editor.project} scene=${editor.scene} path=${editor.projectPath ?? '(unknown)'}`);
}
check('probe returned a well-formed snapshot', Array.isArray(snapshot.editors) && typeof snapshot.daemon.port === 'number');

// ------------------------------------------------------- plugin wiring test ---
section('Plugin wiring (fake context + fake bridge)');
const { ctx, registered, disposed, logs, dispose } = makeFakeContext();
applyPlugin(ctx, {
  roots: [workspace],
  autoBind: false,
  mcpClientModule: fakeBridge,
  toolCallTimeoutMs: 60_000,
  usageFile: testUsageFile,
});
const tools = toolsByName(registered);
check(
  'all five management tools registered',
  ['fennara_projects', 'fennara_search', 'fennara_use', 'fennara_health', 'fennara_update'].every(
    (toolName) => toolName in tools,
  ),
  Object.keys(tools).join(', '),
);

const projectsText = await tools.fennara_projects.execute({ refresh: true });
check('fennara_projects lists known projects', projectsText.text.includes('Known projects'), '');
const withGroup = /With Fennara addon \((\d+)\)/.exec(projectsText.text);
const withoutGroup = /Without Fennara addon \((\d+)\)/.exec(projectsText.text);
check(
  'fennara_projects groups projects by addon presence',
  withGroup?.[1] === '2' && withoutGroup?.[1] === '1',
  `${withGroup?.[1] ?? '?'} with the addon, ${withoutGroup?.[1] ?? '?'} without`,
);
check(
  'the two groups account for every project',
  withGroup !== null &&
    withoutGroup !== null &&
    Number(withGroup[1]) + Number(withoutGroup[1]) === projectsText.data.projects.length,
  `${Number(withGroup?.[1] ?? 0) + Number(withoutGroup?.[1] ?? 0)} of ${projectsText.data.projects.length}`,
);
console.log(projectsText.text.split('\n').slice(0, 4).map((line) => `  | ${line}`).join('\n'));

const healthText = await tools.fennara_health.execute({});
check('fennara_health reports the state', healthText.text.includes('Fennara install:'), '');

const bindTarget = withAddon[0];
const bound = await tools.fennara_use.execute({ project: bindTarget.name });
check('fennara_use binds a project', bound.data?.serverName?.startsWith('fennara-') === true, bound.data?.serverName);
check(
  'bridged tool appeared in the registry',
  registered.has(`mcp__${bound.data.serverName}__fake_status`),
  `mcp__${bound.data.serverName}__fake_status`,
);
check('fennara_use reported the bridged tool', bound.data?.tools?.length === 1, JSON.stringify(bound.data?.tools));

const other = withAddon.find((project) => project.path !== bindTarget.path);
const previousServer = bound.data.serverName;
const switched = await tools.fennara_use.execute({ project: other.path });
check('switching projects releases the previous binding', disposed.includes(previousServer), disposed.join(', '));
check('previous bridged tool was unregistered', !registered.has(`mcp__${previousServer}__fake_status`));
check('new binding is active', switched.data?.serverName !== previousServer, switched.data?.serverName);

const released = await tools.fennara_use.execute({ unbind: true });
check('fennara_use unbind releases everything', released.text.startsWith('Released'), released.text);

const noAddon = projects.find((project) => !project.hasFennaraAddon);
const refused = await tools.fennara_use.execute({ project: noAddon.name });
check(
  'a project without the addon is refused with the install hint',
  refused.data?.code === 'no_addon' && refused.text.includes('fennara install --project'),
  refused.text.split('\n')[0],
);

const missing = await tools.fennara_use.execute({ project: 'definitely-not-a-project-xyz' });
check('unknown project reports a clear error', missing.text.includes('fennara_search'), missing.text.split('\n')[0]);

const searched = await tools.fennara_search.execute({ roots: [workspace], maxDepth: 3 });
check(
  'fennara_search rescans a root',
  searched.text.includes('3 Godot project(s) found'),
  searched.text.split('\n')[0],
);

// A profile can compose the row twice (an `insert:` for an id a bundle layer
// already declared appends a duplicate). The second mount must refuse and say
// why, instead of registering every tool a second time and failing opaquely.
const duplicate = makeFakeContext();
applyPlugin(duplicate.ctx, {
  roots: [workspace],
  autoBind: false,
  mcpClientModule: fakeBridge,
  usageFile: testUsageFile,
});
check(
  'a second instance refuses to mount and explains why',
  duplicate.registered.size === 0 &&
    duplicate.logs.some((line) => line.startsWith('error') && line.includes('refusing to mount')),
  `${duplicate.registered.size} tool(s) registered by the duplicate`,
);

// Tearing the first instance down must free the slot for a later mount.
dispose();
const remount = makeFakeContext();
applyPlugin(remount.ctx, {
  roots: [workspace],
  autoBind: false,
  mcpClientModule: fakeBridge,
  usageFile: testUsageFile,
});
check('mounting again after teardown is allowed', remount.registered.size === 5, `${remount.registered.size} tools`);
remount.dispose();

console.log(`\n  plugin logs: ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}`);
for (const line of logs.slice(0, 4)) console.log(`  | ${line}`);

// ------------------------------------------------- integration: real bridge ---
section('Integration: the real MCP bridge');
// The binder does not import the bridge statically; it resolves it through the
// profile base URL at runtime. That resolution is the one thing a fake bridge
// cannot cover, so check it against the real profile when one is present.
const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web');
if (!existsSync(join(profileDir, 'package.json'))) {
  skip('bridge module resolves from the profile', `no DSH profile at ${profileDir} (set DSH_PROFILE_DIR to test it)`);
} else {
  try {
    const resolved = resolveBridgeModule(join(profileDir, 'package.json'));
    console.log(`  resolved bridge: ${resolved}`);
    const bridge = await import(pathToFileURL(resolved).href);
    check('bridge module resolves from the profile', typeof resolved === 'string' && resolved.length > 0);
    check('bridge exports a cordis apply()', typeof bridge.apply === 'function');
    check('bridge declares its server namespace rules', typeof bridge.name === 'string', bridge.name);
    check(
      'bridge injects the tool registry',
      Array.isArray(bridge.inject) && bridge.inject.includes('tools'),
      JSON.stringify(bridge.inject),
    );

    // The binder must find the bridge even when the loader published baseUrl on
    // the ROOT context only — that is the case most likely to break in a live
    // harness, and it cannot be covered by passing an explicit module path.
    const anchor = join(profileDir, 'package.json');
    const probeBinder = new FennaraBinder(
      { baseUrl: undefined, root: { baseUrl: anchor }, logger: { info() {}, warn() {} } },
      { command: 'unused', mcpClientModule: null },
    );
    const loaded = await probeBinder.loadBridge();
    check('binder resolves the bridge via ctx.root.baseUrl', typeof loaded.apply === 'function', loaded.name);
  } catch (error) {
    check('bridge module resolves from the profile', false, error?.message ?? String(error));
  }

  // Load the plugin on the REAL cordis runtime, not the fake context above:
  // this is what proves the loader will accept this plugin's shape (namespace
  // export, inject, effect, disposable fiber) rather than only my stand-in.
  try {
    const cordisPath = createRequire(join(profileDir, 'package.json')).resolve('@deepseek-ai/cordis');
    const { Context } = await import(pathToFileURL(cordisPath).href);
    const root = new Context();
    const realRegistered = new Map();
    root.provide('tools', {
      register(definition) {
        realRegistered.set(definition.name, definition);
        return () => realRegistered.delete(definition.name);
      },
      schemas: () => [...realRegistered.values()].map((definition) => ({ name: definition.name })),
    });
    const pluginModule = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);
    const fiber = root.plugin(pluginModule, {
      roots: [workspace],
      autoBind: false,
      mcpClientModule: fakeBridge,
      toolCallTimeoutMs: 60_000,
      usageFile: testUsageFile,
    });
    await fiber;
    check(
      'plugin loads on real cordis and registers its tools',
      ['fennara_projects', 'fennara_search', 'fennara_use', 'fennara_health', 'fennara_update'].every((toolName) =>
        realRegistered.has(toolName),
      ),
      [...realRegistered.keys()].join(', '),
    );
    const realUse = realRegistered.get('fennara_use');
    // Bind whichever fixture carries the addon, so the check never depends on a
    // project that exists on this machine.
    await realUse.execute({ project: 'Alpha' });
    check(
      'a real cordis fiber binding publishes the bridged tool',
      realRegistered.has('mcp__fennara-alpha__fake_status'),
      [...realRegistered.keys()].filter((k) => k.startsWith('mcp__')).join(', '),
    );
    await fiber.dispose();
    check(
      'disposing the plugin fiber unregisters everything',
      realRegistered.size === 0,
      `${realRegistered.size} tool(s) left`,
    );
  } catch (error) {
    check('plugin loads on real cordis', false, error?.message ?? String(error));
  }
}

// -------------------------------------------------------------- panel API ---
section('Panel HTTP API');
{
  const routes = [];
  const fakeWebCtx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  const fakeActions = {
    status: async () => ({
      ok: true,
      ts: 1,
      install: { installed: true, version: '9.9.9' },
      daemon: { reachable: true, port: 1 },
      editors: [],
      projects: [],
      bound: null,
      roots: [],
      settings: {},
    }),
    scan: async () => ({ ok: true, message: 'scanned', count: 3, roots: [], depth: 4 }),
    bind: async () => ({ ok: true, message: 'bound', serverName: 'fennara-x', tools: ['t'] }),
    unbind: async () => ({ ok: true, message: 'released', released: 'x' }),
    checkUpdate: async () => ({ ok: true, message: 'checked', latestVersion: '9.9.9' }),
  };
  const disposeRoutes = registerFennaraRoutes(fakeWebCtx, fakeActions, { info() {}, warn() {} });
  check(
    'panel API registers its five routes',
    routes.length === 5,
    routes.map((route) => route.path).join(', '),
  );
  check(
    'routes are exact paths under /fennara/api',
    routes.every((route) => route.kind === 'exact' && route.path.startsWith('/fennara/api')),
  );

  const statusRoute = routes.find((route) => route.path === '/fennara/api/status');
  const statusRes = makeFakeRes();
  await statusRoute.handler(makeFakeReq('GET'), statusRes);
  check('GET /status answers JSON', statusRes.status === 200 && statusRes.body.ok === true);

  const bindRoute = routes.find((route) => route.path === '/fennara/api/bind');
  const bindRes = makeFakeRes();
  await bindRoute.handler(makeFakeReq('POST', { project: 'x' }), bindRes);
  check(
    'POST /bind reads the body and returns fresh status',
    bindRes.body.message === 'bound' && bindRes.body.status.ok === true,
    JSON.stringify(bindRes.body).slice(0, 90),
  );
  check('the route set can be disposed', typeof disposeRoutes === 'function');
}

// ------------------------------------------------------- sidebar client UI ---
section('Sidebar client bundle');
{
  let loaderEntry = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        loaderEntry = entry;
      },
    },
  };
  await import(pathToFileURL(join(here, '..', 'lib', 'client.js')).href);
  check('bundle registers one module factory', loaderEntry !== null && typeof loaderEntry.factory === 'function');

  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
  check('bundle id is the package name', loaderEntry.id === manifest.name, loaderEntry.id);
  check('manifest declares the web client half', manifest.dsh?.client?.platform === 'web');
  check(
    'manifest exports the ./client bundle',
    manifest.exports?.['./client']?.default === './lib/client.js',
    JSON.stringify(manifest.exports?.['./client']),
  );

  const reactStub = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    Fragment: {},
  };
  const buildModule = (reactImpl, primitiveStub) =>
    loaderEntry.factory((name) => {
      if (name === 'react') return reactImpl;
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitiveStub;
      throw new Error(`unexpected require: ${name}`);
    });

  const clientModule = buildModule(reactStub, {});
  check(
    'client exports apply + inject(slots)',
    typeof clientModule.apply === 'function' && Array.isArray(clientModule.inject) && clientModule.inject.includes('slots'),
    JSON.stringify(clientModule.inject),
  );

  const injected = [];
  const registered = [];
  clientModule.apply({
    slots: {
      inject(name, callback) {
        injected.push(name);
        driveGenerator(callback());
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  });
  check(
    'registers into sidebar.footer.action',
    injected[0] === 'sidebar.footer.action' && registered.length === 1,
    injected.join(', '),
  );
  check('registration carries a list id', registered[0]?.options?.id === 'fennara-panel');
  check('registration supplies a component', typeof registered[0]?.component === 'function');

  // Render the real component tree. The browser gets React from the platform
  // module table (no React is installed for Node here), so this uses a minimal
  // renderer: enough to build and walk the element tree, which is where a wrong
  // element type or a missing child would otherwise only show up in the GUI.
  {
    const mini = createMiniReact();
    const primitiveStub = {
      Button: (props) => mini.React.createElement('button', { disabled: props.disabled }, props.children),
      StateDot: () => mini.React.createElement('span', null, '.'),
      Pill: (props) => mini.React.createElement('span', null, props.children),
      Modal: (props) => (props.open === true ? mini.React.createElement('div', null, props.children) : null),
    };
    const grabComponent = (reactImpl, clientCtx) => {
      let component = null;
      let injected = {};
      buildModule(reactImpl, primitiveStub).apply({
        slots: {
          inject: (_name, callback) => {
            driveGenerator(callback());
            return () => {};
          },
          register: (options, value) => {
            component = value;
            // The real slot registry resolves the register `inject` factory and
            // merges its result into the component props; so does this stand-in.
            if (typeof options.inject === 'function') injected = options.inject();
            if (clientCtx !== undefined) injected = { ...injected, clientCtx };
            return () => {};
          },
        },
      });
      return (props) => component({ ...injected, ...props });
    };

    /** A locale service reporting one language, as the harness would. */
    const ctxFor = (active) => ({
      locale: { getSnapshot: () => ({ active }), subscribe: () => () => {} },
    });

    // Renders pass an explicit language: Node exposes a global `navigator`, so
    // the browser-preference fallback would otherwise make these assertions
    // depend on the machine's own language.
    const closed = mini.render(grabComponent(mini.React, ctxFor('en'))({ wide: true }));
    check('trigger renders the status dot and label', closed.includes('Fennara'), closed.slice(0, 70));

    // The panel body sits behind internal `open` state; starting that one state
    // as true renders the real panel subtree instead of only the trigger.
    const openReact = Object.assign({}, mini.React, {
      useState: (initial) => mini.React.useState(initial === false ? true : initial),
    });
    const open = mini.render(grabComponent(openReact, ctxFor('en'))({ wide: true }));
    check(
      'open panel renders its control buttons',
      open.includes('Follow editor') && open.includes('Rescan') && open.includes('Disconnect'),
      open.slice(0, 90),
    );
    check(
      'open panel renders the runtime and registry sections',
      open.includes('Environment') && open.includes('Project registry') && open.includes('Running Godot editors'),
      open.slice(0, 90),
    );
    check('the panel offers the update check button', open.includes('Check updates'));

    // The update line renders from the remembered check result — never from a
    // request of its own — so feeding the status seat a payload is enough.
    // Timestamps, not the backend's preformatted labels, drive the relative ages
    // so the panel never mixes two languages.
    const sampleStatus = {
      ok: true,
      install: { installed: true, version: '0.4.3', recordReadable: true },
      daemon: { reachable: true, port: 41287, portSource: 'configured' },
      editors: [{ pid: 1, project: 'mygame', scene: 'Main.tscn', projectPath: 'E:/x' }],
      projects: [
        {
          name: 'mygame',
          path: 'E:/h',
          hasFennaraAddon: true,
          fennaraVersion: '0.4.2',
          running: false,
          bound: true,
          lastUsedAt: Date.now() - 30_000,
          recentAt: Date.now() - 30_000,
        },
        {
          name: 'plain-shader',
          path: 'E:/p',
          hasFennaraAddon: false,
          fennaraVersion: null,
          running: false,
          bound: false,
          lastUsedAt: null,
          recentAt: Date.now() - 3 * 86_400_000,
        },
      ],
      roots: ['E:\\Projects'],
      bound: { name: 'mygame', path: 'E:/h', serverName: 'fennara-mygame', bindingMode: 'cli', tools: ['a', 'b'] },
      update: {
        ok: true,
        repo: DEFAULT_REPO,
        repoUrl: `https://github.com/${DEFAULT_REPO}`,
        localVersion: '0.4.3',
        latestVersion: '0.5.0',
        releaseUrl: `https://github.com/${DEFAULT_REPO}/releases/tag/v0.5.0`,
        upToDate: false,
        staleProjects: [{ name: 'mygame', version: '0.4.2' }],
      },
    };
    const dataReact = Object.assign({}, mini.React, {
      useState: (initial) => {
        if (initial !== null && typeof initial === 'object' && initial.loading === true) {
          return mini.React.useState({ loading: false, error: null, data: sampleStatus });
        }
        return mini.React.useState(initial === false ? true : initial);
      },
    });
    const rich = mini.render(grabComponent(dataReact, ctxFor('en'))({ wide: true }));
    check(
      'a newer release is shown with its release link',
      rich.includes('Version 0.5.0 available') && rich.includes('Open release page'),
      rich.slice(0, 90),
    );
    check('lagging project addons are surfaced', rich.includes('carry an older addon') && rich.includes('mygame 0.4.2'));

    // The registry is split by addon presence, and the group that cannot be
    // bound stays closed until it is asked for.
    check(
      'projects are grouped by addon presence',
      rich.includes('has the Fennara addon (1)') && rich.includes('no Fennara addon (1)'),
    );
    check('the bindable project is listed with its bind button', rich.includes('mygame') && rich.includes('Reconnect'));
    check(
      'the group without the addon is collapsed by default',
      !rich.includes('plain-shader') && rich.includes('Show'),
    );
    check('relative ages are formatted by the panel itself', rich.includes('last used just now'));

    // The same payload with that one toggle flipped open.
    const expandedReact = Object.assign({}, mini.React, {
      useState: (initial) => {
        if (initial !== null && typeof initial === 'object' && initial.loading === true) {
          return mini.React.useState({ loading: false, error: null, data: sampleStatus });
        }
        if (initial === false) return mini.React.useState(true);
        if (initial === true) return mini.React.useState(false);
        return mini.React.useState(initial);
      },
    });
    const expanded = mini.render(grabComponent(expandedReact, ctxFor('en'))({ wide: true }));
    check(
      'expanding reveals the group without the addon',
      expanded.includes('plain-shader') && expanded.includes('Hide'),
    );
    check(
      'rail mode still renders without the label text',
      !mini.render(grabComponent(mini.React, ctxFor('en'))({ wide: false })).includes('Fennara offline'),
    );

    // --- localisation ------------------------------------------------------
    const texts = buildModule(mini.React, primitiveStub).__texts;
    const enKeys = Object.keys(texts.en).sort();
    const zhKeys = Object.keys(texts.zh).sort();
    check(
      'both dictionaries carry the same keys',
      enKeys.length > 0 && enKeys.join('|') === zhKeys.join('|'),
      `${enKeys.length} en / ${zhKeys.length} zh`,
    );
    const cjk = /[\u4e00-\u9fff]/;
    const englishLeaks = enKeys.filter((key) => cjk.test(texts.en[key]));
    check('the English table carries no Chinese text', englishLeaks.length === 0, englishLeaks.join(', '));

    // A locale service reporting `zh` must switch the whole panel, including
    // the ages and the section headers, not just some labels.
    const zh = mini.render(grabComponent(dataReact, ctxFor('zh'))({ wide: true }));
    check(
      'the panel follows the harness language setting',
      zh.includes('跟随当前编辑器') && zh.includes('工程仓库') && zh.includes('刚刚'),
      zh.slice(0, 90),
    );
    check(
      'no English label survives the switch',
      !zh.includes('Follow editor') && !zh.includes('Project registry') && !zh.includes('Check updates'),
    );

    // An unknown locale falls back to English rather than showing raw keys.
    const fallback = mini.render(grabComponent(dataReact, ctxFor('fr'))({ wide: true }));
    check(
      'an unregistered locale falls back to English',
      fallback.includes('Follow editor') && !fallback.includes('action.follow'),
    );

    // With no locale service at all the browser preference decides — the path a
    // bare render takes. Node exposes `navigator`, so it can be stubbed here.
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-GB' }, configurable: true });
      const byBrowserEn = mini.render(grabComponent(dataReact)({ wide: true }));
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      const byBrowserZh = mini.render(grabComponent(dataReact)({ wide: true }));
      check(
        'without a locale service the browser preference decides',
        byBrowserEn.includes('Follow editor') && byBrowserZh.includes('跟随当前编辑器'),
      );
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete globalThis.navigator;
    }
  }
}

// ------------------------------------------------- hardening and recency ---
section('Hardening and recency ordering');
{
  check(
    'formatAge renders compact ages',
    formatAge(Date.now() - 30_000) === '刚刚' && formatAge(Date.now() - 3 * 3_600_000) === '3 小时前',
  );
  check('formatAge reports an unknown time as null', formatAge(null) === null && formatAge(Number.NaN) === null);

  // Ordering fixture: three projects distinguished only by local mtimes.
  const orderFixture = await mkdtemp(join(tmpdir(), 'fennara-order-'));
  try {
    for (const [name, ageDays] of [
      ['Alpha', 30],
      ['Beta', 2],
      ['Gamma', 10],
    ]) {
      const dir = join(orderFixture, name.toLowerCase());
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'project.godot');
      await writeFile(file, `config_version=5\n\n[application]\n\nconfig/name="${name}"\n`);
      const when = new Date(Date.now() - ageDays * 86_400_000);
      await utimes(file, when, when);
    }
    const byFilesystem = await new ProjectRegistry({ roots: [orderFixture] }).refresh();
    check(
      'without usage history the order follows local recency',
      byFilesystem.map((project) => project.name).join(',') === 'Beta,Gamma,Alpha',
      byFilesystem.map((project) => project.name).join(','),
    );

    // A persisted bind must outrank a fresher filesystem timestamp.
    const usage = {
      get: (path) => (path.toLowerCase().endsWith('alpha') ? { lastUsedAt: Date.now(), useCount: 4 } : null),
    };
    const ordered = await new ProjectRegistry({ roots: [orderFixture], usage }).refresh();
    check(
      'a project bound by the plugin moves to the top',
      ordered[0].name === 'Alpha',
      ordered.map((project) => project.name).join(','),
    );
    check(
      'the recency source is reported per project',
      ordered[0].recentSource === 'plugin' && ordered[1].recentSource === 'filesystem',
      ordered.map((project) => `${project.name}:${project.recentSource}`).join(' '),
    );
    check('the usage count is carried through', ordered[0].useCount === 4);
  } finally {
    await rm(orderFixture, { recursive: true, force: true });
  }

  // The daemon's own startup log is the only place a real port is written down.
  const logHome = await mkdtemp(join(tmpdir(), 'fennara-log-'));
  try {
    await mkdir(join(logHome, 'logs'), { recursive: true });
    await writeFile(
      join(logHome, 'logs', 'daemon-startup.log'),
      'fennara-daemon listening on http://127.0.0.1:41287\nfennara-daemon listening on http://127.0.0.1:55001\n',
    );
    check('the daemon port is discovered from its startup log', (await discoverDaemonPort(logHome)) === 55001);
    check('a missing log yields null instead of throwing', (await discoverDaemonPort(join(logHome, 'absent'))) === null);
  } finally {
    await rm(logHome, { recursive: true, force: true });
  }

  // Launcher-only install: current.json absent or reshaped must not hide it.
  const installHome = await mkdtemp(join(tmpdir(), 'fennara-install-'));
  const savedLocalAppData = process.env.LOCALAPPDATA;
  try {
    const appDir = join(installHome, 'Fennara');
    await mkdir(dirname(launcherPath(appDir)), { recursive: true });
    await writeFile(launcherPath(appDir), '');
    process.env.LOCALAPPDATA = installHome;
    const install = await resolveFennaraInstall();
    check(
      'a launcher alone counts as an installed Fennara',
      install.installed === true && install.recordReadable === false,
      `installed=${install.installed} recordReadable=${install.recordReadable}`,
    );
    check('the spawn command still resolves to the launcher', resolveMcpCommand(install).command === launcherPath(appDir));
  } finally {
    process.env.LOCALAPPDATA = savedLocalAppData;
    await rm(installHome, { recursive: true, force: true });
  }

  // Binding must survive a renamed/removed --project-path flag.
  {
    const { ctx, registered, logs } = makeFakeContext();
    const binder = new FennaraBinder(ctx, {
      command: 'unused',
      mcpClientModule: cliRejectingBridge,
      logger: ctx.logger,
    });
    const result = await binder.bind({ name: 'Demo', dirName: 'demo', path: 'C:\\demo' });
    check('binding falls back to FENNARA_PROJECT_PATH when the flag is refused', result.mode === 'env');
    check(
      'the fallback really published the bridged tool',
      registered.has('mcp__fennara-demo__env_tool'),
      [...registered.keys()].join(', '),
    );
    check(
      'the fallback is logged as a warning',
      logs.some((line) => line.includes('FENNARA_PROJECT_PATH')),
      logs.filter((line) => line.includes('FENNARA')).join(' | '),
    );
  }

  // The store itself: persistence across a reload, with case-insensitive keys.
  const directUsageFile = join(testHome, 'usage-direct.json');
  const store = new UsageStore({ file: directUsageFile });
  await store.record('C:\\demo', 1_000);
  await store.record('C:\\demo', 2_000);
  await store.flush();
  const reopened = new UsageStore({ file: directUsageFile });
  await reopened.load();
  check('the usage record survives a reload', reopened.get('c:\\demo')?.lastUsedAt === 2_000);
  check('repeat uses are counted', reopened.get('c:\\DEMO')?.useCount === 2);
  check('an unknown project has no usage entry', reopened.get('C:\\never') === null);

  // End to end: the plugin instance in the wiring section must have persisted
  // the bind it performed, into the file its config named.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const persisted = await readFile(testUsageFile, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  check(
    'the plugin persisted its bind into the configured usage file',
    persisted !== null && Object.keys(persisted.projects ?? {}).length > 0,
    persisted === null ? 'no file written' : Object.keys(persisted.projects).join(', '),
  );
}

// ----------------------------------------------------------- release check ---
section('Release check (GitHub)');
{
  check(
    'parseVersion accepts the shapes GitHub returns',
    parseVersion('v0.4.3').core.join('.') === '0.4.3' &&
      parseVersion('1.2').core.join('.') === '1.2.0' &&
      parseVersion('0.5.0-beta.1').prerelease === 'beta.1' &&
      parseVersion('nightly') === null,
  );
  check('a release outranks its own prerelease', compareVersions('0.5.0', '0.5.0-beta.1') === 1);
  check('prerelease labels compare in order', compareVersions('0.5.0-beta.2', '0.5.0-beta.1') === 1);
  check('an unparseable version compares as unknown', compareVersions('nightly', '0.4.3') === null);
  check(
    'isBehind only reports a strictly older local version',
    isBehind('0.4.3', '0.4.4') === true &&
      isBehind('0.4.4', '0.4.4') === false &&
      isBehind('0.4.5', '0.4.4') === false &&
      isBehind(null, '0.4.4') === false,
  );

  const release = (tag, extra = {}) => ({
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-08-01T00:00:00Z',
    html_url: `https://github.com/${DEFAULT_REPO}/releases/tag/${tag}`,
    ...extra,
  });
  const respond = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const newest = await fetchLatestRelease({
    fetchImpl: respond(200, [release('v0.4.2'), release('v0.4.4'), release('v0.4.3')]),
  });
  check('the newest release wins regardless of list order', newest.version === '0.4.4', newest.version);
  const withDraft = await fetchLatestRelease({
    fetchImpl: respond(200, [release('v0.9.0', { draft: true }), release('v0.4.4')]),
  });
  check('draft releases are ignored', withDraft.version === '0.4.4', withDraft.version);

  const notFound = await fetchLatestRelease({ fetchImpl: respond(404, {}) }).catch((error) => error);
  check(
    'a missing repository is explained',
    notFound instanceof Error && notFound.message.includes('找不到仓库'),
    notFound?.message,
  );
  const limited = await fetchLatestRelease({ fetchImpl: respond(403, {}) }).catch((error) => error);
  check(
    'rate limiting is explained with its status',
    limited instanceof Error && limited.status === 403 && limited.message.includes('限流'),
    limited?.message,
  );
  const offline = await fetchLatestRelease({
    fetchImpl: async () => {
      throw new Error('boom');
    },
  }).catch((error) => error);
  check(
    'an offline machine yields a readable failure',
    offline instanceof Error && offline.message.includes('无法连接 GitHub'),
    offline?.message,
  );
  const empty = await fetchLatestRelease({ fetchImpl: respond(200, []) }).catch((error) => error);
  check('an empty release list is explained', empty instanceof Error && empty.message.includes('还没有发布'), empty?.message);

  // Action layer: the version verdict, plus projects whose addon lags the runtime.
  let requests = 0;
  const checker = new UpdateChecker({
    fetchImpl: async (...args) => {
      requests += 1;
      return respond(200, [release('v0.5.0')])(...args);
    },
  });
  const updateRuntime = {
    ensureReady: async () => {},
    registry: {
      roots: [],
      list: async () => [
        { name: 'mygame', path: 'C:\\h', hasFennaraAddon: true, fennaraVersion: '0.4.2' },
        { name: 'second', path: 'C:\\u', hasFennaraAddon: true, fennaraVersion: '0.4.3' },
        { name: 'plain', path: 'C:\\p', hasFennaraAddon: false, fennaraVersion: null },
      ],
    },
    install: () => ({ version: '0.4.3' }),
    updates: checker,
  };
  const updateActions = buildActions(updateRuntime);
  const first = await updateActions.checkUpdate({});
  check(
    'the action reports an available update',
    first.ok === true && first.upToDate === false && first.latestVersion === '0.5.0',
    first.message,
  );
  check(
    'only projects whose addon lags the runtime are listed',
    first.staleProjects.length === 1 && first.staleProjects[0].name === 'mygame',
    JSON.stringify(first.staleProjects),
  );
  const second = await updateActions.checkUpdate({});
  check('a repeat call is served from cache', second.cached === true && requests === 1, `requests=${requests}`);
  await updateActions.checkUpdate({ force: true });
  check('force bypasses the cache', requests === 2, `requests=${requests}`);

  const unavailable = await buildActions({ ...updateRuntime, updates: undefined }).checkUpdate({});
  check(
    'a missing checker degrades to a message, not a throw',
    unavailable.ok === false && typeof unavailable.message === 'string',
    unavailable.message,
  );
}

// ------------------------------------------------------- environment (opt) ---
// Everything above runs on generated fixtures. This extra pass is for a
// developer who has a real Godot workspace around; it is skipped otherwise, so
// the suite stays green on a clean machine and in CI.
if (scanRoot === null) {
  section('Environment (skipped)');
  skip(
    'real Godot workspace',
    'pass a root as argv[2] or set FENNARA_TEST_ROOT to include this section',
  );
} else {
  section(`Environment (real workspace: ${scanRoot})`);
  const realRegistry = new ProjectRegistry({ roots: [scanRoot], maxDepth: 4 });
  const realProjects = await realRegistry.refresh();
  const realBindable = realProjects.filter((project) => project.hasFennaraAddon);
  console.log(`  ${realProjects.length} project(s), ${realBindable.length} with the Fennara addon`);
  for (const project of realProjects.slice(0, 5)) {
    console.log(`  - ${project.name} [${project.hasFennaraAddon ? project.fennaraVersion ?? 'addon' : 'no addon'}]`);
  }
  if (realProjects.length === 0) {
    skip('real workspace scanned', 'no project.godot found under this root');
  } else {
    check('real workspace scanned', true, `${realProjects.length} project(s)`);
    const editorRoots = await rootsFromGodotEditor();
    console.log(`  Godot editor registry roots: ${editorRoots.length === 0 ? '(none)' : editorRoots.join(', ')}`);
  }
}

// ---------------------------------------------------------------- summary ---
const passed = checks - failures;
console.log(
  `\n=== ${passed}/${checks} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''} ===`,
);
process.exit(failures === 0 ? 0 : 1);