
// Modo personal: un único usuario con token privado; no distribuir este token en una app pública.
// Para varios usuarios, integrar sesiones individuales en createAPIHandler.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAPIHandler } from './api-handler.mjs';

const personalMode = process.env.NUTRITRACK_AUTH_MODE === 'personal';
if (process.env.NODE_ENV === 'production' && !personalMode) {
  throw new Error('Configura NUTRITRACK_AUTH_MODE=personal para uso privado, o integra sesiones de usuarios.');
}
const tokenName = personalMode ? 'NUTRITRACK_PERSONAL_TOKEN' : 'NUTRITRACK_DEV_TOKEN';
const token = process.env[tokenName];
const minimumLength = personalMode ? 32 : 24;
if (!token || token.length < minimumLength || /\s/.test(token)) {
  throw new Error(`Define ${tokenName} con al menos ${minimumLength} caracteres y sin espacios.`);
}
if (personalMode && !process.env.OPENAI_API_KEY?.trim()) {
  throw new Error('Define OPENAI_API_KEY en las variables del servidor.');
}
const expected = Buffer.from('Bearer ' + token);
const handler = createAPIHandler({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  workoutModel: process.env.OPENAI_WORKOUT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  planModel: process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  recipeModel: process.env.OPENAI_RECIPE_MODEL || process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  authenticate: async request => {
    const supplied = Buffer.from(request.headers.get('authorization') || '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      ? { id: personalMode ? 'personal-user' : 'development-user' } : null;
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
const host = personalMode ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => console.log(
  `NutriTrack 5.0: ${personalMode ? 'uso personal' : 'desarrollo'}, puerto ${server.address().port}`
));

