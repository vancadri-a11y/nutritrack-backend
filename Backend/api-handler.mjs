import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPlanHandler } from './plan-handler.mjs';
import { createWorkoutHandler } from './workout-handler.mjs';
import { createVisionHandler } from './vision-handler.mjs';

const catalog = JSON.parse(readFileSync(new URL('../Shared/recipes.json', import.meta.url), 'utf8'));
const MAX_BODY = 2800000;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Límite por usuario en un solo proceso. Sustituir por almacenamiento compartido al escalar. */
export class RequestLimiter {
  constructor({ limit = 12, windowMS = 60000, capacity = 1000, now = Date.now } = {}) {
    this.limit = limit; this.windowMS = windowMS; this.capacity = capacity; this.now = now;
    this.users = new Map();
  }
  take(user) {
    const now = this.now();
    for (const [key, value] of this.users) if (value.until <= now) this.users.delete(key);
    let entry = this.users.get(user);
    if (!entry) {
      if (this.users.size >= this.capacity) return { allowed: false, retry: 60 };
      entry = { count: 0, until: now + this.windowMS }; this.users.set(user, entry);
    }
    if (entry.count >= this.limit) return { allowed: false, retry: Math.max(1, Math.ceil((entry.until - now) / 1000)) };
    entry.count++;
    return { allowed: true, retry: 0 };
  }
}

async function limitedBody(request) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY) throw new RangeError('large');
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new RangeError('large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/**
 * Contrato v4. authenticate devuelve { id: "id-de-usuario" } tras validar una sesión.
 * Nunca se registran fotos, claves ni tokens. El caché guarda solo respuestas por 5 minutos.
 */
export function createAPIHandler({
  apiKey, model, workoutModel = model, planModel = workoutModel, authenticate, fetchImpl = fetch, limiter = new RequestLimiter(),
  now = Date.now, cacheTTL = 300000, cacheCapacity = 200, maximumConcurrent = 4,
  providerTimeoutMS = 40000
}) {
  if (typeof authenticate !== 'function') throw new Error('Falta autenticación de usuarios.');
  const provider = apiKey ? createVisionHandler({
    apiKey, model, authenticate: async () => true, fetchImpl, timeoutMS: providerTimeoutMS
  }) : null;
  const workoutProvider = apiKey ? createWorkoutHandler({ apiKey, model: workoutModel, fetchImpl, timeoutMS: providerTimeoutMS }) : null;
  const planProvider = apiKey ? createPlanHandler({ apiKey, model: planModel, fetchImpl, timeoutMS: providerTimeoutMS }) : null;
  const cache = new Map();
  const pending = new Map();
  let active = 0;

  return async request => {
    const suppliedID = request.headers.get('x-request-id') || '';
    const requestID = /^[A-Za-z0-9-]{8,80}$/.test(suppliedID) ? suppliedID : randomUUID();
    const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestID, ...headers }
    });
    const fail = (error, message, status, headers) => reply({ error, message, request_id: requestID }, status, headers);
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return reply({ status: 'ok', version: '4.0' });
    if (!['/v1/recipes', '/v1/food/analyze', '/v1/workouts/generate', '/v1/plans/generate'].includes(url.pathname)) return fail('not_found', 'Ruta no disponible.', 404);
    const expectedMethod = url.pathname === '/v1/recipes' ? 'GET' : 'POST';
    if (request.method !== expectedMethod) return fail('method_not_allowed', 'Método no permitido.', 405, { Allow: expectedMethod });
    let identity;
    try { identity = await authenticate(request); } catch { /* Fallo cerrado. */ }
    if (!identity || typeof identity.id !== 'string' || !identity.id || identity.id.length > 200) {
      return fail('unauthorized', 'Inicia sesión de nuevo.', 401);
    }
    if (url.pathname === '/v1/recipes') {
      const category = url.searchParams.get('category');
      if (category && !['desayuno', 'comida', 'cena', 'colacion'].includes(category)) return fail('invalid_category', 'Categoría desconocida.', 400);
      const q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('es').slice(0, 100);
      return reply({ ...catalog, recipes: catalog.recipes.filter(r =>
        (!category || r.category === category) && (!q || (r.title + ' ' + r.tags.join(' ')).toLocaleLowerCase('es').includes(q))
      ) });
    }
    const selectedProvider = url.pathname === '/v1/plans/generate' ? planProvider : url.pathname === '/v1/workouts/generate' ? workoutProvider : provider;
    if (!selectedProvider) return fail('service_not_configured', 'El análisis aún no está configurado.', 503);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return fail('unsupported_media_type', 'Envía un cuerpo JSON.', 415);
    }
    const limit = limiter.take(identity.id);
    if (!limit.allowed) return fail('rate_limited', 'Espera antes de volver a intentarlo.', 429, { 'Retry-After': String(limit.retry) });
    let body;
    try { body = await limitedBody(request); }
    catch (error) { return fail('invalid_request', 'La imagen o el cuerpo no son válidos.', error instanceof RangeError ? 413 : 400); }
    if (request.signal.aborted) return fail('cancelled', 'Solicitud cancelada.', 499);
    const idempotency = request.headers.get('idempotency-key');
    if (idempotency && !/^[A-Za-z0-9_-]{16,100}$/.test(idempotency)) return fail('invalid_key', 'Identificador de solicitud inválido.', 400);
    const fingerprint = hash(body);
    const key = hash(identity.id) + ':' + url.pathname + ':' + (idempotency || randomUUID());
    const time = now();
    for (const [key, item] of cache) if (item.expires <= time) cache.delete(key);
    const previous = cache.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict', 'El identificador ya pertenece a otra solicitud.', 409);
      return reply(previous.result, 200, { 'X-Analysis-Cache': 'hit' });
    }
    if (pending.has(key)) {
      if (pending.get(key) !== fingerprint) return fail('idempotency_conflict', 'El identificador ya pertenece a otra solicitud.', 409);
      return fail('analysis_in_progress', 'El análisis ya está en curso.', 409, { 'Retry-After': '2' });
    }
    if (active >= maximumConcurrent) return fail('service_busy', 'El servicio está ocupado. Inténtalo en unos segundos.', 503, { 'Retry-After': '5' });
    active++; pending.set(key, fingerprint);
    try {
      const normalized = new Request(request.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: request.signal
      });
      const result = await selectedProvider(normalized);
      const payload = await result.json();
      if (result.ok) {
        if (cache.size >= cacheCapacity) cache.delete(cache.keys().next().value);
        cache.set(key, { fingerprint, result: payload, expires: now() + cacheTTL });
        return reply(payload, 200, { 'X-Analysis-Cache': 'miss' });
      }
      const messages = {
        invalid_plan_request: 'Revisa los datos de tu perfil y las preferencias.',
        invalid_plan: 'La propuesta no superó la validación. Puedes volver a intentarlo.',
        plan_unavailable: 'No se puede generar esta propuesta. Ajusta las preferencias o consulta a un profesional para necesidades clínicas.',
        invalid_context: 'Revisa el peso y las notas de la porción.',
        invalid_workout_request: 'Revisa edad, objetivo, actividad y duración de la rutina.',
        invalid_workout: 'No se recibió una semana de ejercicios válida. Vuelve a intentarlo.',
        no_food: 'No se distingue comida suficiente en la foto.',
        invalid_image: 'La imagen no es válida.',
        analysis_timeout: 'El análisis tardó demasiado. Puedes volver a intentarlo.',
        invalid_analysis: 'La respuesta no contenía una estimación válida.',
        incomplete_analysis: 'El análisis no se completó.',
        provider_unavailable: 'El servicio de análisis no está disponible en este momento.'
      };
      return fail(payload.error, messages[payload.error] || 'No se pudo completar el análisis.',
        payload.error === 'analysis_timeout' ? 504 : result.status,
        result.status === 429 ? { 'Retry-After': result.headers.get('retry-after') || '30' } : {});
    } catch {
      return fail('internal_error', 'No se pudo completar la solicitud.', 500);
    } finally { active--; pending.delete(key); }
  };
}
