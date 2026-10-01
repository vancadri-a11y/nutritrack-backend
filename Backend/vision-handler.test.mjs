import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderRequest, createVisionHandler, SYSTEM_PROMPT } from './vision-handler.mjs';

const estimate = { is_food: true, summary: 'Comida', calories: 520, protein: 35,
  carbs: 59, fat: 16, confidence: 'medium', notes: 'Porción aproximada.' };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).toString('base64');
const request = (changes = {}) => new Request('https://example.test/v1/food/analyze', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image_base64: jpeg, mime_type: 'image/jpeg', prompt_version: 'food-v1', ...changes })
});
const response = (value = estimate, changes = {}) => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  ...changes
}), { status: 200 });
const handler = fetchImpl => createVisionHandler({ apiKey: 'unit-test-key', authenticate: async () => true, fetchImpl });

test('construye Responses con instrucciones fijas, imagen y JSON Schema estricto', () => {
  const body = buildProviderRequest(jpeg, 'test-model');
  assert.equal(body.instructions, SYSTEM_PROMPT);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.store, false);
  assert.equal(body.input[0].content[1].image_url, `data:image/jpeg;base64,${jpeg}`);
});
test('normaliza la envoltura HTTP del proveedor al contrato iOS', async () => {
  let called = false;
  const result = await handler(async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
    return response();
  })(request());
  assert.equal(called, true);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), estimate);
});
test('rechaza falta de sesión antes de invocar al proveedor', async () => {
  const h = createVisionHandler({ apiKey: 'test', authenticate: async () => false,
    fetchImpl: async () => { throw new Error('No debe invocarse'); } });
  assert.equal((await h(request())).status, 401);
});
test('rechaza imágenes inválidas y versión de prompt desconocida', async () => {
  const h = handler(async () => { throw new Error('No debe invocarse'); });
  assert.equal((await h(request({ image_base64: 'invalid' }))).status, 400);
  assert.equal((await h(request({ prompt_version: 'override' }))).status, 400);
});
test('no acepta macros negativos ni campos ausentes', async () => {
  assert.equal((await handler(async () => response({ ...estimate, protein: -1 }))(request())).status, 502);
  const { carbs, ...missing } = estimate;
  assert.equal((await handler(async () => response(missing))(request())).status, 502);
});
test('distingue no-food, rechazo e incompleto', async () => {
  assert.equal((await handler(async () => response({ ...estimate, is_food: false }))(request())).status, 422);
  assert.equal((await handler(async () => response(estimate, { status: 'incomplete' }))(request())).status, 502);
  assert.equal((await handler(async () => response(estimate, {
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }]
  }))(request())).status, 502);
});
test('propaga límite temporal sin filtrar mensajes del proveedor', async () => {
  const result = await handler(async () => new Response('private provider details', { status: 429 }))(request());
  assert.equal(result.status, 429);
  assert.deepEqual(await result.json(), { error: 'provider_unavailable' });
});
test('rechaza cuerpos demasiado grandes antes del proveedor', async () => {
  const result = await handler(async () => { throw new Error('No debe invocarse'); })(request({ image_base64: 'A'.repeat(2800001) }));
  assert.equal(result.status, 413);
});
