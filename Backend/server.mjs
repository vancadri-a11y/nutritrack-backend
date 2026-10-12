
// Supabase es el modo multiusuario predeterminado. Los modos personal y development son privados.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAPIHandler } from './api-handler.mjs';
import { createSupabaseBackend } from './supabase-backend.mjs';

const mode = process.env.NUTRITRACK_AUTH_MODE || 'supabase';
const personalMode = mode === 'personal';
if (!['supabase', 'personal', 'development'].includes(mode)) throw new Error('Modo de autenticación inválido.');
if (process.env.NODE_ENV === 'production' && mode === 'development') throw new Error('No uses autenticación de desarrollo en producción.');
const options = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  workoutModel: process.env.OPENAI_WORKOUT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  planModel: process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  recipeModel: process.env.OPENAI_RECIPE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  onVisionDiagnostic: entry => console.warn(JSON.stringify(entry))
};
if ((personalMode || mode === 'supabase') && !options.apiKey?.trim()) throw new Error('Define OPENAI_API_KEY en el servidor.');
let handler;
if (mode === 'supabase') {
  handler = createSupabaseBackend({ ...options, supabaseURL: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, secretKey: process.env.SUPABASE_SECRET_KEY,
    recoveryRedirectURL:process.env.NUTRITRACK_RECOVERY_URL });
} else {
  const tokenName = personalMode ? 'NUTRITRACK_PERSONAL_TOKEN' : 'NUTRITRACK_DEV_TOKEN';
  const token = process.env[tokenName];
  if (!token || token.length < (personalMode ? 32 : 24) || /\s/.test(token)) throw new Error(`Define ${tokenName} con suficiente longitud.`);
  const expected = Buffer.from('Bearer ' + token);
  handler = createAPIHandler({ ...options, authenticate: async request => {
    const supplied = Buffer.from(request.headers.get('authorization') || '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      ? { id: personalMode ? 'personal-user' : 'development-user' } : null;
  }});
}

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
const host = mode === 'development' ? '127.0.0.1' : '0.0.0.0';
server.listen(port, host, () => console.log(
  `NutriTrack 5.7: ${mode}, puerto ${server.address().port}`
));
