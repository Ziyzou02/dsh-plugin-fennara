/**
 * Self-test fixture: a bridge that refuses the `--project-path` CLI flag the
 * way a future Fennara build might after renaming it, and accepts only the
 * `FENNARA_PROJECT_PATH` environment variable. Used to prove the binder's
 * documented fallback path really runs.
 */
export const name = 'cli-rejecting-bridge';

export const inject = ['tools'];

export function apply(ctx, config) {
  if (Array.isArray(config.args) && config.args.includes('--project-path')) {
    throw new Error('unknown Fennara MCP option: "--project-path"');
  }
  const project = config.env?.FENNARA_PROJECT_PATH;
  if (typeof project !== 'string' || project === '') {
    throw new Error('no project binding was provided');
  }
  ctx.tools.register({
    name: `mcp__${config.serverName}__env_tool`,
    description: `bound ${project} through the environment`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      return { text: project };
    },
  });
}
