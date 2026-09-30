// Adaptador de desarrollo: para producción inyectar autenticación real en createAPIHandler.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAPIHandler } from './api-handler.mjs';

const token = process.env.NUTRITRACK_DEV_TOKEN;
if (process.env.NODE_ENV === 'production') {
  throw new Error('Integra api-handler.mjs con autenticación real de usuarios antes de desplegar.');
}
if (!token || token.length < 24) throw new Error('Define NUTRITRACK_DEV_TOKEN con al menos 24 caracteres.');
const expected = Buffer.from('Bearer ' + token);
const handler = createAPIHandler({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  workoutModel: process.env.OPENAI_WORKOUT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  planModel: process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  authenticate: async request => {
    const supplied = Buffer.from(request.headers.get('authorization') || '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      ? { id: 'development-user' } : null;
  }
});

const server = createServer(async (req, res) => {
  const abort = new AbortController();
  req.on('aborted', () => abort.abort());
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const method = req.method || 'GET';
    const request = new Request(new URL(req.url || '/', 'http://127.0.0.1'), {
      method, headers, signal: abort.signal,
      ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(req), duplex: 'half' } : {})
    });
    const response = await handler(request);
    req.resume();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{"error":"invalid_request","message":"Solicitud inválida."}');
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 55000;
server.keepAliveTimeout = 5000;
const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => console.log('NutriTrack 4.0, desarrollo: http://127.0.0.1:' + port));
