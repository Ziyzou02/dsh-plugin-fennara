/**
 * Stand-in for `@deepseek-ai/dsh-mcp-client` used by the offline self-test.
 * Mimics the bridge's contract: namespace plugin, registers one tool per
 * server namespace through `ctx.effect` (exactly how the real bridge scopes its
 * tool disposers), so fiber disposal unregisters the tools.
 */
export const name = 'fake-bridge';

export const inject = ['tools'];

export function apply(ctx, config) {
  const register = () =>
    ctx.tools.register({
      name: `mcp__${config.serverName}__fake_status`,
      description: `fake tool for ${config.serverName}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        return { text: `${config.serverName} ok (project=${config.args?.[1] ?? '?'})` };
      },
    });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = register();
      return () => dispose();
    }, 'fake-bridge.tools');
  } else {
    register();
  }
}
