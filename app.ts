import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, Store } from './store.ts';
import { rest } from './rest.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value === null || typeof value !== 'object') throw new Error('Expected JSON object');
    return value;
  }
  catch { throw new ApiError(400, 'Malformed JSON'); }
}
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  let requestId = 0;
  return createServer(async (req, res) => {
    res.setHeader('X-GitHub-Request-Id', (++requestId).toString(16));
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'entry'}`);
      const method = req.method || 'GET';
      if (method === 'GET' && url.pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      const api = url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.includes('.git/');
      if (api && (!token || req.headers.authorization !== `Bearer ${token}`)) throw new ApiError(401, 'Bad credentials');
      if (url.pathname.startsWith('/api/v3')) {
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : {};
        const [status, value] = rest(store, method, url, body, res);
        sendJson(res, status, value); return;
      }
      throw new ApiError(404, 'Not Found');
    } catch (error) {
      sendJson(res, error instanceof ApiError ? error.status : 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
    }
  });
}
