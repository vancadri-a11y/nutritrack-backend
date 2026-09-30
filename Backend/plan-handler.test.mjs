import test from 'node:test';
import assert from 'node:assert/strict';
import { createAPIHandler } from './api-handler.mjs';
import { validPlan } from './plan-handler.mjs';
import { days } from './workout-handler.mjs';
const input = { age: 35, weightKG: 74, heightCM: 170, goal: 'maintain', activity: 'light', reference: 'female', minutes: 25, preferences: 'Vegetariano' };
const plan = () => ({ nutrition: { calories: 2000, protein: 125, carbs: 225, fat: 2000 * 0.3 / 9, explanation: 'Propuesta orientativa.',
  meals: ['Desayuno', 'Comida', 'Cena', 'Colación'].map((name, i) => ({ name, suggestion: 'Verduras y legumbres; ajustar porción.', calorieBudget: [500,700,600,200][i] })) },
  sessions: days.map((day, i) => ({ day, title: i === 6 ? 'Descanso' : 'Caminata', minutes: i === 6 ? 0 : 20, exercises: ['Camina a un ritmo cómodo.'] })) });
const request = (body = input, user = 'a') => new Request('https://example.test/v1/plans/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'plan-request-000001', 'X-User': user }, body: JSON.stringify(body)
});
const upstream = (value = plan()) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
const handler = (options = {}) => createAPIHandler({ apiKey: 'test', authenticate: async r => ({ id: r.headers.get('x-user') }), fetchImpl: async () => upstream(), ...options });
test('plan usa todo el contexto, schema estricto y no envía nombre ni Salud', async () => {
  const h = handler({ fetchImpl: async (_url, options) => {
    const data = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(data.input), input); assert.equal(data.store, false);
    assert.equal(data.text.format.strict, true);
    return upstream();
  } });
  const response = await h(request()); assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.source, 'ai'); assert.equal(value.sessions.length, 7);
  assert.match(value.nutrition.meals[0].id, /^[a-f0-9-]{36}$/);
});
test('rechaza contexto incompleto, no finito, fuera de rango y campos adicionales sin cobrar', async () => {
  for (const body of [{ ...input, age: 17 }, { ...input, weightKG: 0 }, { ...input, heightCM: null }, { ...input, preferences: 'x'.repeat(601) }, { ...input, name: 'personal' }]) {
    const response = await handler({ fetchImpl: async () => assert.fail('No invocar proveedor') })(request(body));
    assert.equal(response.status, 400);
  }
});
test('rechaza incoherencia energética, macros, comidas desordenadas y sesiones excesivas', async () => {
  for (const change of [p => p.nutrition.calories = 1000, p => p.nutrition.meals[0].calorieBudget = 800,
    p => p.nutrition.protein = 1, p => p.nutrition.meals[0].name = 'Cena', p => p.sessions[0].minutes = 26]) {
    const p = plan(); change(p);
    assert.equal((await handler({ fetchImpl: async () => upstream(p) })(request())).status, 502);
  }
  assert.equal(validPlan(plan()), true);
});
test('idempotencia y aislamiento por usuario de propuestas', async () => {
  let calls = 0;
  const h = handler({ fetchImpl: async () => { calls++; return upstream(); } });
  const a = await (await h(request())).json();
  assert.deepEqual(await (await h(request())).json(), a); assert.equal(calls, 1);
  await h(request(input, 'b')); assert.equal(calls, 2);
  assert.equal((await h(request({ ...input, preferences: 'otra' }))).status, 409);
});
test('planes requieren sesión y configuración', async () => {
  assert.equal((await handler({ authenticate: async () => null })(request())).status, 401);
  assert.equal((await handler({ apiKey: undefined })(request())).status, 503);
});
test('rechazo del modelo, respuesta enorme y timeout no reemplazan un plan', async () => {
  const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] };
  assert.equal((await handler({ fetchImpl: async () => new Response(JSON.stringify(refusal)) })(request())).status, 422);
  assert.equal((await handler({ fetchImpl: async () => new Response('x'.repeat(512001)) })(request())).status, 502);
  const h = handler({ providerTimeoutMS: 5, fetchImpl: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')))) });
  assert.equal((await h(request())).status, 504);
});
