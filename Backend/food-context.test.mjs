import test from 'node:test';
import assert from 'node:assert/strict';
import { createAPIHandler } from './api-handler.mjs';
const jpeg = Buffer.from([255,216,255,224,255,217]).toString('base64');
const context = { measuredGrams: 300, notes: 'Con aceite', consumedFraction: 0.5 };
const estimate = () => ({ is_food: true, summary: 'Plato', calories: 520, protein: 35, carbs: 59, fat: 16, confidence: 'medium', notes: 'Peso indicado; preparación estimada.',
  analysis: { calorieLow: 420, calorieHigh: 620, question: '¿Cuánto aceite usaste?', items: [{ name: 'Plato mixto', grams: 300, calories: 520, protein: 35, carbs: 59, fat: 16 }] } });
const response = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
const req = (data = context) => new Request('https://example.test/v1/food/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image_base64: jpeg, mime_type: 'image/jpeg', prompt_version: 'food-v2', context: data }) });
const make = options => createAPIHandler({ apiKey: 'test', authenticate: async () => ({ id: 'a' }), fetchImpl: async () => response(estimate()), ...options });
test('v2 transmite peso/notas como datos y escala la porción una sola vez en servidor', async () => {
  const h = make({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.text.format.name, 'food_analysis_v2'); assert.equal(body.text.format.strict, true);
    assert.ok(body.input[0].content[0].text.includes('300'));
    assert.ok(!body.input[0].content[0].text.includes('consumedFraction'));
    return response(estimate());
  } });
  const result = await h(req()); assert.equal(result.status, 200);
  const e = await result.json(); assert.equal(e.calories, 260); assert.equal(e.protein, 17.5);
  assert.equal(e.analysis.items[0].grams, 150); assert.equal(e.analysis.calorieLow, 210);
});
test('contexto inválido se rechaza antes de invocar al proveedor', async () => {
  for (const value of [{ ...context, measuredGrams: -1 }, { ...context, consumedFraction: 3 }, { ...context, notes: 'x'.repeat(601) }, { ...context, override: true }, null]) {
    assert.equal((await make({ fetchImpl: async () => assert.fail('No cobrar') })(req(value))).status, 400);
  }
});
test('totales, gramos y rango deben coincidir con el desglose', async () => {
  for (const change of [e => e.analysis.items[0].calories = 40, e => e.analysis.items[0].grams = 500,
    e => e.analysis.calorieLow = 800, e => e.analysis.items = [], e => e.analysis.items[0].fat = -1]) {
    const value = estimate(); change(value);
    assert.equal((await make({ fetchImpl: async () => response(value) })(req())).status, 502);
  }
});
test('cambiar datos con igual clave genera conflicto; clave nueva permite afinar', async () => {
  const h = make();
  const a = req(); a.headers.set('Idempotency-Key', 'scan-context-00001');
  assert.equal((await h(a)).status, 200);
  const b = req({ ...context, notes: 'Sin aceite' }); b.headers.set('Idempotency-Key', 'scan-context-00001');
  assert.equal((await h(b)).status, 409);
  const c = req({ ...context, notes: 'Sin aceite' }); c.headers.set('Idempotency-Key', 'scan-context-00002');
  assert.equal((await h(c)).status, 200);
});

test('v5 analiza fotos distintas con respuestas distintas y no comparte resultados entre ellas', async () => {
  let calls = 0;
  const seen = [];
  const h = make({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    seen.push(request.input[0].content.find(c => c.type === 'input_image').image_url);
    const result = estimate();
    if (++calls === 2) {
      result.summary = 'Otra comida';
      result.calories = 300; result.protein = 20; result.carbs = 37; result.fat = 8;
      result.analysis.items = [{ name: 'Otra comida', grams: 300, calories: 300, protein: 20, carbs: 37, fat: 8 }];
      result.analysis.calorieLow = 250; result.analysis.calorieHigh = 350;
    }
    return response(result);
  } });
  const a = req({ ...context, consumedFraction: 1 });
  a.headers.set('Idempotency-Key', 'scan-photo-v5-image-0001');
  const b = new Request(a.url, {method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'scan-photo-v5-image-0002'},body:JSON.stringify({image_base64:Buffer.from([255,216,255,225,1,255,217]).toString('base64'),mime_type:'image/jpeg',prompt_version:'food-v2',context:{...context,consumedFraction:1}})});
  const first = await (await h(a)).json();
  const second = await (await h(b)).json();
  assert.equal(calls, 2); assert.notEqual(seen[0], seen[1]);
  assert.notEqual(first.calories, second.calories); assert.notEqual(first.summary, second.summary);
});
