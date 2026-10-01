import test from 'node:test';
import assert from 'node:assert/strict';
import { createAPIHandler, RequestLimiter } from './api-handler.mjs';

const estimate = { is_food: true, summary: 'Comida', calories: 520, protein: 35, carbs: 59,
  fat: 16, confidence: 'medium', notes: 'Porción estimada.' };
const jpeg = Buffer.from([255, 216, 255, 224, 255, 217]).toString('base64');
const upstream = () => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(estimate) }] }]
}));
function req({ path = '/v1/food/analyze', method = 'POST', body, user = 'a', key = 'same-image-key-000001' } = {}) {
  return new Request('https://example.test' + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-User': user, 'Idempotency-Key': key },
    ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body ?? {
      image_base64: jpeg, mime_type: 'image/jpeg', prompt_version: 'food-v1'
    }) } : {})
  });
}
const make = (options = {}) => createAPIHandler({
  apiKey: 'test-key', authenticate: async request => ({ id: request.headers.get('x-user') || 'test' }),
  fetchImpl: async () => upstream(), ...options
});

test('health está disponible sin claves y no expone configuración', async () => {
  const handler = make({ apiKey: undefined, authenticate: async () => null });
  const response = await handler(req({ path: '/health', method: 'GET' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', version: '5.0' });
});

test('el catálogo requiere sesión y permite filtros', async () => {
  assert.equal((await make({ authenticate: async () => null })(req({ path: '/v1/recipes', method: 'GET' }))).status, 401);
  const response = await make()(req({ path: '/v1/recipes?category=desayuno&q=avena', method: 'GET' }));
  const data = await response.json();
  assert.equal(data.version, '2.0');
  assert.equal(data.recipes.length, 2);
  assert.ok(data.recipes.every(r => r.category === 'desayuno'));
});

test('catálogo local con estructura y balance de macros coherentes', async () => {
  const data = await (await make()(req({ path: '/v1/recipes', method: 'GET' }))).json();
  assert.equal(data.recipes.length, 8);
  assert.equal(new Set(data.recipes.map(r => r.id)).size, 8);
  for (const r of data.recipes) {
    assert.equal(r.calories, r.protein * 4 + r.carbs * 4 + r.fat * 9);
    assert.ok(r.ingredients.length > 0 && r.steps.length > 0);
    assert.ok(r.ingredients.every(i => i.quantity > 0));
  }
});

test('rutas, métodos y categorías inválidos tienen estado explícito', async () => {
  const handler = make();
  assert.equal((await handler(req({ path: '/unknown' }))).status, 404);
  assert.equal((await handler(req({ path: '/v1/recipes' }))).status, 405);
  assert.equal((await handler(req({ path: '/v1/recipes?category=unknown', method: 'GET' }))).status, 400);
});

test('análisis sin proveedor configurado se informa sin romper el catálogo', async () => {
  const handler = make({ apiKey: undefined });
  assert.equal((await handler(req())).status, 503);
  assert.equal((await handler(req({ path: '/v1/recipes', method: 'GET' }))).status, 200);
});

test('idempotencia evita una segunda llamada para la misma imagen y usuario', async () => {
  let calls = 0;
  const handler = make({ fetchImpl: async () => { calls++; return upstream(); } });
  const first = await handler(req());
  const second = await handler(req());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-analysis-cache'), 'hit');
  assert.equal(calls, 1);
});

test('el caché está separado por usuario', async () => {
  let calls = 0;
  const handler = make({ fetchImpl: async () => { calls++; return upstream(); } });
  await handler(req({ user: 'a' }));
  await handler(req({ user: 'b' }));
  assert.equal(calls, 2);
});

test('reutilizar un identificador con otra imagen devuelve conflicto', async () => {
  const handler = make();
  await handler(req());
  const response = await handler(req({ body: { image_base64: 'different' } }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'idempotency_conflict');
});

test('las entradas del caché vencen', async () => {
  let time = 0, calls = 0;
  const handler = make({ now: () => time, cacheTTL: 100, fetchImpl: async () => { calls++; return upstream(); } });
  await handler(req()); time = 101; await handler(req());
  assert.equal(calls, 2);
});

test('el límite por usuario incluye Retry-After y se recupera tras la ventana', async () => {
  let time = 0;
  const limiter = new RequestLimiter({ limit: 1, windowMS: 1000, now: () => time });
  const handler = make({ limiter });
  assert.equal((await handler(req())).status, 200);
  const blocked = await handler(req({ key: 'another-image-key-0002' }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '1');
  time = 1001;
  assert.equal((await handler(req({ key: 'another-image-key-0002' }))).status, 200);
});

test('solicitudes simultáneas del mismo análisis no duplican al proveedor', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const handler = make({ fetchImpl: async () => {
    started(); await new Promise(resolve => { release = resolve; }); return upstream();
  } });
  const pending = handler(req());
  await ready;
  const duplicate = await handler(req());
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'analysis_in_progress');
  release(); assert.equal((await pending).status, 200);
});

test('el límite global de concurrencia se libera tras terminar', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  let first = true;
  const handler = make({ maximumConcurrent: 1, fetchImpl: async () => {
    if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); }
    return upstream();
  } });
  const pending = handler(req());
  await ready;
  assert.equal((await handler(req({ user: 'b' }))).status, 503);
  release(); await pending;
  assert.equal((await handler(req({ user: 'b' }))).status, 200);
});

test('rechaza un cuerpo demasiado grande antes del proveedor', async () => {
  const result = await make()(req({ body: { image_base64: 'A'.repeat(2800001) } }));
  assert.equal(result.status, 413);
});

test('los errores incorporan un identificador sin filtrar claves', async () => {
  const result = await make({ fetchImpl: async () => { throw new Error('test-key private'); } })(req());
  const text = await result.text();
  assert.equal(result.status, 502);
  assert.ok(result.headers.get('x-request-id'));
  assert.ok(!text.includes('test-key') && !text.includes('private'));
});

test('timeout del proveedor devuelve 504 y permite reintentar', async () => {
  const handler = make({ providerTimeoutMS: 5, fetchImpl: async (_url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    })
  });
  const result = await handler(req());
  assert.equal(result.status, 504);
  assert.equal((await result.json()).error, 'analysis_timeout');
});

test('respuestas del proveedor demasiado grandes se rechazan', async () => {
  const handler = make({ fetchImpl: async () => new Response('x'.repeat(512001)) });
  const result = await handler(req());
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error, 'invalid_analysis');
});
