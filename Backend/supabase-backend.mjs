import { confirmationPage } from './confirmation-page.mjs';
import { createAPIHandler, RequestLimiter } from './api-handler.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers }
});
class InputError extends Error {}
async function body(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new InputError();
  if (!request.body) throw new InputError();
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 32768) { await reader.cancel(); throw new InputError(); }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError();
    return data;
  } catch { throw new InputError(); } finally { reader.releaseLock(); }
}
function text(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InputError();
  return value;
}
function number(value, max, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > max) throw new InputError();
  return value;
}
function date(value) {
  text(value, 40); if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new InputError();
  return new Date(value).toISOString();
}
function validateProfile(data, user) {
  const allowed = ['name', 'height_cm', 'weight_kg', 'age', 'goal', 'activity', 'timezone'];
  if (Object.keys(data).some(k => !allowed.includes(k)) || !Object.keys(data).length) throw new InputError();
  const out = { user_id: user };
  for (const [key, value] of Object.entries(data)) {
    if (key === 'height_cm') out[key] = number(value, 300, 30);
    else if (key === 'weight_kg') out[key] = number(value, 700, 1);
    else if (key === 'age') { out[key] = number(value, 120, 1); if (!Number.isInteger(value)) throw new InputError(); }
    else { out[key] = text(value, key === 'name' ? 100 : 80); }
  }
  if (out.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: out.timezone }); } catch { throw new InputError(); } }
  return out;
}
function validateMeal(data, user) {
  const allowed = ['id', 'recorded_at', 'title', 'meal_type', 'calories', 'protein', 'carbs', 'fat', 'notes', 'origin'];
  if (Object.keys(data).some(k => !allowed.includes(k))) throw new InputError();
  if (!UUID.test(data.id || '')) throw new InputError();
  if (!['desayuno', 'comida', 'cena', 'colacion'].includes(data.meal_type)) throw new InputError();
  if (!['manual', 'photo', 'recipe'].includes(data.origin)) throw new InputError();
  return { id: data.id, user_id: user, recorded_at: date(data.recorded_at), title: text(data.title, 200),
    meal_type: data.meal_type, origin: data.origin, calories: number(data.calories, 50000),
    protein: number(data.protein, 10000), carbs: number(data.carbs, 10000), fat: number(data.fat, 10000),
    notes: text(data.notes ?? '', 2000, false) };
}

/** Uses the user's JWT for PostgREST: never bypasses RLS with an admin key. */
export function createSupabaseBackend({ supabaseURL, publishableKey, apiKey, fetchImpl = fetch, ...aiOptions }) {
  const root = new URL(supabaseURL);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash || root.pathname !== '/') {
    throw new Error('SUPABASE_URL debe ser una URL HTTPS sin rutas.');
  }
  if (!publishableKey?.trim() || publishableKey.startsWith('sb_secret_')) throw new Error('Usa SUPABASE_PUBLISHABLE_KEY, no una clave administrativa.');
  const globalLimit = new RequestLimiter({ limit: 600, capacity: 1 });
  const userLimit = new RequestLimiter({ limit: 120, capacity: 10000 });
  const authLimit = new RequestLimiter({ limit: 60, capacity: 1 });
  const call = async (path, { token, method = 'GET', data, prefer, signal } = {}) => {
    const response = await fetchImpl(new URL(path, root), {
      method, headers: { apikey: publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) },
      body: data ? JSON.stringify(data) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    return { response, payload };
  };
  const authenticate = async request => {
    const header = request.headers.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9._-]{20,8192}$/.test(header)) return null;
    const token = header.slice(7);
    const { response, payload } = await call('/auth/v1/user', { token, signal: request.signal });
    return response.ok && UUID.test(payload?.id || '') ? { id: payload.id, token, email: payload.email } : null;
  };
  const ai = createAPIHandler({ ...aiOptions, apiKey, fetchImpl, authenticate });
  const authMessages = {
    weak_password: 'Usa una contraseña de al menos 12 caracteres que cumpla los requisitos de seguridad.',
    email_address_not_authorized: 'El envío de correos de Supabase aún no está configurado para esta dirección. Configura SMTP para registrar usuarios.',
    email_provider_disabled: 'El registro por correo está desactivado en Supabase.',
    signup_disabled: 'El registro de usuarios está desactivado en Supabase.',
    email_not_confirmed: 'Confirma tu correo antes de iniciar sesión.',
    invalid_credentials: 'Correo o contraseña incorrectos.',
    email_address_invalid: 'Revisa el formato del correo electrónico.',
    over_email_send_rate_limit: 'Se alcanzó el límite de correos. Espera antes de intentarlo de nuevo.',
    over_request_rate_limit: 'Demasiados intentos. Espera antes de volver a intentar.',
    captcha_failed: 'Supabase requiere una verificación CAPTCHA que esta pantalla aún no admite.'
  };
  const failure = (result, auth = false) => {
    const code = auth && Object.hasOwn(authMessages, result.payload?.code) ? result.payload.code : null;
    return json({ error: code || (result.response.status === 429 ? 'rate_limited' : 'request_rejected'),
      message: code ? authMessages[code] : result.response.status >= 500 ? 'Servicio no disponible.' : 'No se pudo completar la solicitud.' },
      result.response.status >= 500 ? 503 : result.response.status === 429 ? 429 : 400);
  };
  return async request => {
    const url = new URL(request.url); const path = url.pathname;
    if (path === '/auth/confirmed') return request.method === 'GET' ? confirmationPage() : json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    if (path === '/health') return request.method === 'GET' ? json({ status: 'ok', version: '5.1', auth: 'supabase' }) : json({ error: 'method_not_allowed' }, 405);
    if (!globalLimit.take('global').allowed) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    try {
      const authRoutes = { '/v1/auth/register': '/auth/v1/signup', '/v1/auth/login': '/auth/v1/token?grant_type=password',
        '/v1/auth/refresh': '/auth/v1/token?grant_type=refresh_token', '/v1/auth/recover': '/auth/v1/recover' };
      if (path in authRoutes) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
        if (!authLimit.take('auth').allowed) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
        const input = await body(request); let data;
        if (path.endsWith('/refresh')) data = { refresh_token: text(input.refresh_token, 8192) };
        else {
          const email = text(input.email, 254).trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError();
          data = { email };
          if (!path.endsWith('/recover')) {
            data.password = text(input.password, 1024);
            if (path.endsWith('/register') && data.password.length < 12) throw new InputError();
          }
        }
        // Forward CAPTCHA proof when enabled in Supabase, never arbitrary user metadata.
        if (input.captcha_token) data.gotrue_meta_security = { captcha_token: text(input.captcha_token, 4096) };
        const result = await call(authRoutes[path], { method: 'POST', data, signal: request.signal });
        if (path.endsWith('/recover')) return result.response.status >= 500 ? failure(result) : json({ message: 'Si la cuenta existe, recibirás un correo.' });
        if (!result.response.ok) return failure(result, true);
        const p = result.payload;
        if (p?.access_token && p?.refresh_token) return json({ access_token: p.access_token, refresh_token: p.refresh_token,
          expires_in: p.expires_in, expires_at: p.expires_at, token_type: 'bearer', user: { id: p.user?.id, email: p.user?.email } });
        return json({ confirmation_required: true, message: 'Revisa tu correo para confirmar la cuenta.' });
      }
      const ownPaths = ['/v1/auth/me', '/v1/auth/logout', '/v1/profile', '/v1/meals'];
      const mealMatch = path.match(/^\/v1\/meals\/([0-9a-f-]+)$/i);
      if (!ownPaths.includes(path) && !mealMatch) return await ai(request);
      const methods = path === '/v1/profile' ? ['GET', 'PATCH'] : path === '/v1/meals' ? ['GET', 'POST'] : mealMatch ? ['DELETE'] : path === '/v1/auth/me' ? ['GET'] : ['POST'];
      if (!methods.includes(request.method)) return json({ error: 'method_not_allowed' }, 405, { Allow: methods.join(', ') });
      const user = await authenticate(request);
      if (!user) return json({ error: 'unauthorized', message: 'Inicia sesión de nuevo.' }, 401);
      if (!userLimit.take(user.id).allowed) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
      if (path === '/v1/auth/me') return json({ id: user.id, email: user.email });
      if (path === '/v1/auth/logout') {
        const result = await call('/auth/v1/logout?scope=local', { method: 'POST', token: user.token, signal: request.signal });
        return result.response.ok ? json({ signed_out: true }) : failure(result);
      }
      let resource; let data; let method = request.method; let prefer;
      if (path === '/v1/profile') {
        resource = `/rest/v1/profiles?user_id=eq.${user.id}&select=*`;
        if (method === 'PATCH') {
          data = validateProfile(await body(request), user.id); method = 'POST';
          resource = '/rest/v1/profiles?on_conflict=user_id'; prefer = 'resolution=merge-duplicates,return=representation';
        }
      } else if (mealMatch) {
        if (!UUID.test(mealMatch[1])) throw new InputError();
        resource = `/rest/v1/meals?user_id=eq.${user.id}&id=eq.${mealMatch[1]}`; prefer = 'return=representation';
      } else if (method === 'POST') {
        data = validateMeal(await body(request), user.id);
        resource = '/rest/v1/meals?on_conflict=user_id,id'; prefer = 'resolution=merge-duplicates,return=representation';
      } else {
        const limit = Number(url.searchParams.get('limit') || 50), offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new InputError();
        resource = `/rest/v1/meals?user_id=eq.${user.id}&select=*&order=recorded_at.desc,id.desc&limit=${limit}&offset=${offset}`;
      }
      const result = await call(resource, { token: user.token, method, data, prefer, signal: request.signal });
      return result.response.ok ? json(result.payload ?? []) : failure(result);
    } catch (error) {
      return json({ error: error instanceof InputError ? 'invalid_request' : 'service_unavailable',
        message: error instanceof InputError ? 'Revisa los datos enviados.' : 'Servicio no disponible. Inténtalo de nuevo.' }, error instanceof InputError ? 400 : 503);
    }
  };
}
