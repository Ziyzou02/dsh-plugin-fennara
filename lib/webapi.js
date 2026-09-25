/**
 * HTTP surface for the sidebar panel.
 *
 * The panel is plain browser code talking to these routes with `fetch`, so it
 * needs no RPC framework and no build step. Every route returns JSON and never
 * throws at the client: failures arrive as `{ ok: false, message }`.
 *
 * @module dsh-plugin-fennara/webapi
 */

/** Base path of every route this plugin owns. */
export const API_PREFIX = '/fennara/api';

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  } catch (error) {
    bytes = Buffer.from(JSON.stringify({ ok: false, message: `serialization failed: ${String(error)}` }), 'utf8');
    status = 500;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
  });
  res.end(bytes);
}

/** Read a small JSON body; an empty body is `{}`. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({});
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Register the panel's routes on the web carrier.
 * @param {object} webCtx context that has `webServer`
 * @param {object} actions shared operations from `actions.js`
 * @param {object} [logger]
 * @returns {() => void} disposer removing every route
 */
export function registerFennaraRoutes(webCtx, actions, logger) {
  const disposers = [];
  const routes = [
    {
      path: `${API_PREFIX}/status`,
      handle: async () => actions.status(),
    },
    {
      path: `${API_PREFIX}/scan`,
      handle: async (body) => {
        const result = await actions.scan(body);
        return { ...result, status: await actions.status() };
      },
    },
    {
      path: `${API_PREFIX}/bind`,
      handle: async (body) => {
        const result = await actions.bind(body);
        return { ...result, status: await actions.status() };
      },
    },
    {
      path: `${API_PREFIX}/unbind`,
      handle: async () => {
        const result = await actions.unbind();
        return { ...result, status: await actions.status() };
      },
    },
    {
      // The only route that leaves the machine. A click means "check now", so it
      // bypasses the checker's cache on purpose.
      path: `${API_PREFIX}/update`,
      handle: async () => {
        const result = await actions.checkUpdate({ force: true });
        return { ...result, status: await actions.status() };
      },
    },
  ];

  for (const route of routes) {
    const handler = async (req, res) => {
      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        sendJson(res, 200, await route.handle(body));
      } catch (error) {
        logger?.warn?.(`fennara: ${route.path} failed: ${error?.message ?? error}`);
        sendJson(res, 500, { ok: false, message: String(error?.message ?? error) });
      }
    };
    try {
      disposers.push(webCtx.webServer.register({ kind: 'exact', path: route.path, handler }));
    } catch (error) {
      logger?.warn?.(`fennara: could not register ${route.path}: ${error?.message ?? error}`);
    }
  }
  logger?.info?.(`fennara: panel API registered under ${API_PREFIX}`);
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* already removed */
      }
    }
  };
}
