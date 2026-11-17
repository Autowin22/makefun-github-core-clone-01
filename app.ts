import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { requestId } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function parseUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'entry';
  const protocol = req.headers['x-forwarded-proto'] ?? 'http';
  try {
    return new URL(req.url ?? '/', `${protocol}://${host}`);
  } catch {
    return new URL('/', 'http://entry');
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = parseUrl(req);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Health probe
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // MCP surface
    if (path === '/mcp') {
      try {
        const handled = await handleMcp(req, res, url);
        if (handled) return;
      } catch (err) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    // REST v3 API surface
    if (path.startsWith('/api/v3')) {
      try {
        const handled = await handleRest(req, res, url);
        if (handled) return;
      } catch (err) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    // GraphQL API surface
    if (path === '/api/graphql' || path === '/api/v3/graphql') {
      try {
        const handled = await handleGraphql(req, res, url);
        if (handled) return;
      } catch (err) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    // Git smart HTTP routes
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) {
      try {
        const handled = await handleGit(req, res, url);
        if (handled) return;
      } catch (err) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    // Everything else
    sendJson(res, 404, { message: 'Not Found' });
  });
}
