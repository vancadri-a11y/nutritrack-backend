import test from 'node:test';
import assert from 'node:assert/strict';
import { createAPIHandler, RequestLimiter } from './api-handler.mjs';
import { days } from './workout-handler.mjs';
const input = { age: 30, goal: 'maintain', activity: 'light', minutes: 25 };
const week = () => ({ sessions: days.map((day, i) => ({ day, title: i === 6 ? 'Descanso' : 'Caminata', minutes: i === 6 ? 0 : 20, exercises: ['Muévete a un ritmo cómodo.'] })) });
const upstream = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
const req = (body = input, path = '/v1/workouts/generate') => new Request('https://example.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'workout-request-00001' }, body: JSON.stringify(body) });
const make = (options = {}) => createAPIHandler({ apiKey: 'test-only', authenticate: async () => ({ id: 'user' }), fetchImpl: async () => upstream(week()), ...options });

test('rutina válida con UUID, máximo de minutos e idempotencia', async () => {
  let calls = 0;
  const handler = make({ fetchImpl: async (_url, options) => {
    calls++; const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    assert.equal(request.text.format.strict, true);
    return upstream(week());
  } });
  const response = await handler(req()); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source, 'ai'); assert.equal(result.sessions.length, 7);
  assert.match(result.sessions[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await (await handler(req())).json(), result);
  assert.equal(calls, 1);
});
test('rutinas requieren sesión, proveedor, cuotas y cuerpo válido', async () => {
  assert.equal((await make({ authenticate: async () => null })(req())).status, 401);
  assert.equal((await make({ apiKey: undefined })(req())).status, 503);
  assert.equal((await make({ limiter: new RequestLimiter({ limit: 0 }) })(req())).status, 429);
  for (const body of [{ ...input, age: 17 }, { ...input, activity: 'extreme' }, { ...input, minutes: 100 }, { ...input, extra: true }]) {
    const handler = make({ fetchImpl: async () => { assert.fail('No debe llamar al proveedor'); } });
    assert.equal((await handler(req(body))).status, 400);
  }
});
test('rechaza días duplicados, semana incompleta, minutos excesivos y falta de descanso', async () => {
  const invalid = [];
  let value = week(); value.sessions[1].day = 'Lunes'; invalid.push(value);
  value = week(); value.sessions.pop(); invalid.push(value);
  value = week(); value.sessions[0].minutes = 26; invalid.push(value);
  value = week(); value.sessions[6].minutes = 20; invalid.push(value);
  value = week(); value.sessions[0].exercises = []; invalid.push(value);
  for (const result of invalid) assert.equal((await make({ fetchImpl: async () => upstream(result) })(req())).status, 502);
});
test('rechaza respuesta enorme, truncada o rechazada por el proveedor', async () => {
  for (const body of ['x'.repeat(512001), JSON.stringify({ status: 'incomplete', output: [] }), JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] })]) {
    assert.equal((await make({ fetchImpl: async () => new Response(body) })(req())).status, 502);
  }
});
test('el tiempo límite de rutinas devuelve 504', async () => {
  const handler = make({ providerTimeoutMS: 5, fetchImpl: async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  assert.equal((await handler(req())).status, 504);
});
test('caché de rutinas separado del análisis de fotos', async () => {
  const handler = make();
  assert.equal((await handler(req())).status, 200);
  const food = await handler(req(input, '/v1/food/analyze'));
  assert.equal(food.status, 400);
  assert.equal((await food.json()).error, 'invalid_image');
});
