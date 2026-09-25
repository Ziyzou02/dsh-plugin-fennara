/**
 * The plugin's own model-facing tools.
 *
 * These are native DSH tools registered on `ctx.tools`, deliberately separate
 * from the bridged `mcp__fennara__*` tools: they manage *which* Godot project
 * is attached, while the bridged tools do the Godot work. The operations live
 * in `actions.js` so the sidebar panel and these tools cannot diverge.
 *
 * @module dsh-plugin-fennara/tools
 */

/** Canonical value shape every tool in this file returns. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' }, data: {} },
    required: ['text'],
    additionalProperties: true,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];
  },
};

const asText = (text, data) => ({ text, data });

function formatEditor(editor) {
  const where = editor.project ?? '(unknown project)';
  const scene = editor.scene ? ` — editing ${editor.scene}` : '';
  const path = editor.projectPath ? ` @ ${editor.projectPath}` : '';
  return `pid ${editor.pid}: ${where}${scene}${path}`;
}

function formatProject(project) {
  const marks = [project.hasFennaraAddon ? `fennara ${project.fennaraVersion ?? 'addon'}` : 'no fennara addon'];
  if (project.imported) marks.push('imported');
  if (project.running) marks.push('RUNNING');
  if (project.bound) marks.push('BOUND');
  const used = project.lastUsedLabel ? ` · used ${project.lastUsedLabel}` : '';
  return `- ${project.name} [${marks.join(', ')}]${used}\n    ${project.path}`;
}

/** Model-facing guidance for each failure code the shared actions report. */
function failureHint(code) {
  switch (code) {
    case 'not_found':
      return ' Run fennara_search to scan the folder that contains it.';
    case 'no_editor':
      return ' Open the project in Godot, or pass `project` explicitly.';
    case 'ambiguous':
      return ' Pass the project explicitly.';
    case 'no_addon':
      return ' Install it, then retry.';
    default:
      return '';
  }
}

/**
 * Build the plugin's tool definitions.
 * @param {object} runtime facade supplied by the plugin entry
 * @param {object} actions shared operations from `actions.js`
 */
export function buildTools(runtime, actions) {
  return [
    {
      name: 'fennara_projects',
      description:
        'List the Godot projects this plugin knows about, together with runtime state: whether the project carries the Fennara addon, whether a Godot editor currently has it open, and which project is bound to the Fennara MCP bridge. Call this before fennara_use to see valid targets.',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Rescan the configured roots instead of serving the cache.' },
          onlyBindable: { type: 'boolean', description: 'Show only projects that have the Fennara addon installed.' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const state = await actions.status({ refresh: args?.refresh === true });
        const visible =
          args?.onlyBindable === true ? state.projects.filter((project) => project.hasFennaraAddon) : state.projects;
        // Same two groups the panel shows, so both surfaces describe the
        // registry the same way.
        const bindable = visible.filter((project) => project.hasFennaraAddon === true);
        const unbindable = visible.filter((project) => project.hasFennaraAddon !== true);
        const group = (projects) => (projects.length > 0 ? projects.map(formatProject) : ['  (none)']);
        const lines = [
          `Fennara: ${state.install.installed ? 'installed' : 'NOT FOUND'}${
            state.install.version ? ` (${state.install.version})` : ''
          }`,
          `Local daemon on port ${state.daemon.port}: ${
            state.daemon.reachable ? 'reachable' : `not reachable (${state.daemon.reason ?? 'unknown'})`
          }`,
          `Bound project: ${state.bound ? `${state.bound.name} (${state.bound.path})` : 'none'}`,
          `Running Godot editors: ${state.editors.length === 0 ? 'none' : ''}`,
          ...state.editors.map((editor) => `  ${formatEditor(editor)}`),
          '',
          `Known projects (${visible.length}), most recently used first:`,
          `With Fennara addon (${bindable.length}) — these can be bound:`,
          ...group(bindable),
          `Without Fennara addon (${unbindable.length}) — install the addon first:`,
          ...group(unbindable),
        ];
        return asText(lines.join('\n'), {
          projects: visible,
          bound: state.bound?.path ?? null,
          editors: state.editors,
          daemon: state.daemon,
        });
      },
    },

    {
      name: 'fennara_search',
      description:
        'Search the filesystem for Godot projects (directories containing project.godot) and add the matches to the plugin registry. Use it to bring a new root into the registry, or to find a project whose name you only partly remember.',
      parameters: {
        type: 'object',
        properties: {
          roots: {
            type: 'array',
            items: { type: 'string' },
            description: 'Directories to scan. Omit to rescan the roots already configured.',
          },
          maxDepth: { type: 'integer', description: 'How deep to descend below each root (default 4).' },
          withFennaraOnly: { type: 'boolean', description: 'Return only projects that have the Fennara addon.' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const explicitRoots = Array.isArray(args?.roots) && args.roots.length > 0;
        if (!explicitRoots && runtime.registry.roots.length === 0) {
          return asText(
            'No scan roots configured. Pass roots explicitly, or configure `roots` in the plugin patch entry.',
            { projects: [] },
          );
        }
        const result = await actions.scan({ roots: args?.roots, maxDepth: args?.maxDepth });
        const matched =
          args?.withFennaraOnly === true
            ? result.projects.filter((project) => project.hasFennaraAddon)
            : result.projects;
        const lines = [
          `Scanned ${result.roots.length} root(s) at depth ${result.depth}: ${result.count} Godot project(s) found.`,
          '',
          ...matched.map((project) => formatProject({ ...project, running: false, bound: false })),
        ];
        if (matched.length === 0) lines.push('(no match)');
        return asText(lines.join('\n'), { roots: result.roots, projects: matched });
      },
    },

    {
      name: 'fennara_use',
      description:
        'Attach a Godot project to the Fennara MCP bridge. Pass a project name or path, or auto:true to follow the Godot editor that is currently running. The project\'s Fennara tools then appear as mcp__<serverName>__* for the rest of the session; binding a different project releases the previous one. Use unbind:true to detach without attaching another.',
      parameters: {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Project name (as shown by fennara_projects), directory name, or absolute path.',
          },
          auto: {
            type: 'boolean',
            description: 'Attach whichever project the running Godot editor currently has open.',
          },
          unbind: { type: 'boolean', description: 'Release the current binding and attach nothing.' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        if (args?.unbind === true) {
          const result = await actions.unbind();
          return asText(result.released ? `Released ${result.released}.` : 'No project was bound.', {
            released: result.released ?? null,
          });
        }
        const result = await actions.bind({ project: args?.project, auto: args?.auto === true });
        if (result.ok !== true) {
          return asText(`${result.message}${failureHint(result.code)}`, result);
        }
        const lines = [
          `Bound ${result.project.name} (${result.project.path}) as "${result.serverName}" via ${result.source}.`,
          result.replaced ? `Released ${result.replaced} first.` : null,
          result.tools.length > 0
            ? `Bridged tools (${result.tools.length}): ${result.tools.join(', ')}`
            : 'The bridge started but reported no tools; call fennara_status to inspect the connection.',
        ].filter(Boolean);
        return asText(lines.join('\n'), {
          project: result.project.path,
          serverName: result.serverName,
          tools: result.tools,
          replaced: result.replaced,
        });
      },
    },

    {
      name: 'fennara_health',
      description:
        'Report Fennara readiness: the installed version and runtime paths, whether the local daemon is listening, which Godot editors are running, and the current MCP binding. Use it when a bridged Fennara tool fails or when Godot seems unreachable.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      async execute() {
        const state = await actions.status({ fresh: true });
        const lines = [
          `Fennara install: ${state.install.installed ? `yes (${state.install.version ?? 'unknown version'})` : 'no'}`,
          `  app dir        : ${state.install.appDir}`,
          `  mcp runtime    : ${state.install.mcpRuntime ?? '(missing)'}`,
          `  spawn command  : ${state.install.command ?? '(missing)'}`,
          `Local daemon     : ${
            state.daemon.reachable
              ? `reachable on ${state.daemon.port}`
              : `not reachable on ${state.daemon.port} (${state.daemon.reason ?? 'unknown'})`
          }`,
          `Process probe    : ${state.processProbe.supported ? 'ok' : `unavailable (${state.processProbe.note})`}`,
          `Running editors  : ${state.editors.length}`,
          ...state.editors.map((editor) => `  ${formatEditor(editor)}`),
          `Registry         : ${state.projects.length} project(s) from ${state.roots.join(', ') || '(no roots)'}`,
          `Bound project    : ${state.bound ? `${state.bound.name} (${state.bound.path})` : 'none'}`,
        ];
        if (!state.daemon.reachable) {
          lines.push('', 'Open a Godot project that has Fennara enabled to start the daemon.');
        }
        return asText(lines.join('\n'), {
          install: state.install,
          daemon: state.daemon,
          editors: state.editors,
          bound: state.bound?.path ?? null,
        });
      },
    },

    {
      name: 'fennara_update',
      description:
        'Check the installed Fennara against the newest published release on GitHub, and list any project whose bundled addon is older than the installed runtime. Performs one request to the public GitHub API; the repository is configurable.',
      parameters: {
        type: 'object',
        properties: {
          fresh: {
            type: 'boolean',
            description: 'Bypass the short result cache and query GitHub now instead of reusing the last check.',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const result = await actions.checkUpdate({ force: args?.fresh === true });
        if (result.ok !== true) {
          return asText(
            `Update check failed: ${result.error}\nRepository: ${result.repoUrl}\nInstalled: ${result.localVersion ?? 'unknown'}`,
            result,
          );
        }
        const verdict =
          result.upToDate === true
            ? 'up to date'
            : result.upToDate === false
              ? 'a newer release is available'
              : 'could not compare (unrecognised version format)';
        const lines = [
          `Repository     : ${result.repo} (${result.repoUrl})`,
          `Installed      : ${result.localVersion ?? 'unknown'}`,
          `Latest release : ${result.latestVersion}${result.prerelease ? ' (prerelease)' : ''}${
            result.publishedAt ? ` — published ${String(result.publishedAt).slice(0, 10)}` : ''
          }`,
          `Status         : ${verdict}${result.cached ? ' (cached)' : ''}`,
          `Release page   : ${result.releaseUrl}`,
        ];
        if (Array.isArray(result.staleProjects) && result.staleProjects.length > 0) {
          lines.push(
            '',
            'Projects whose bundled addon is older than the installed runtime:',
            ...result.staleProjects.map((project) => `- ${project.name} (${project.version}) ${project.path}`),
            'Update them with: fennara update --project "<path>"',
          );
        }
        return asText(lines.join('\n'), result);
      },
    },
  ];
}
