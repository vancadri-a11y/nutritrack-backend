import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipeHandler, validRecipeImprovement } from './recipe-handler.mjs';

const input = () => ({
  recipe: { title: 'Avena con fruta', minutes: 10, allergens: 'Leche',
    ingredients: [{ name: 'Avena', quantity: 40, unit: 'g' }, { name: 'Leche', quantity: 150, unit: 'ml' }],
    steps: ['Calienta la leche.', 'Añade la avena y remueve.'] },
  portions: 2, instruction: 'Quiero una preparación cremosa, con menos utensilios.'
});
const improvement = () => ({ title: 'Avena cremosa en una olla', summary: 'Remueve a fuego bajo para una textura cremosa.',
  ingredients: [{ name: 'Avena', quantity: 80, unit: 'g' }, { name: 'Leche', quantity: 300, unit: 'ml' }],
  steps: [{ title: 'Calienta', instruction: 'Añade la leche a una olla y calienta a fuego medio.', minutes: 3 },
    { title: 'Remueve', instruction: 'Añade la avena y remueve a fuego bajo hasta que espese.', minutes: 5 }],
  tips: ['Usa una olla de fondo grueso.'], nutritionNote: 'Revisa los nutrientes al registrar.', allergyNote: 'Contiene leche.'
});
const request = (body = input()) => new Request('https://example.test/v1/recipes/improve', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const upstream = (value = improvement()) => new Response(JSON.stringify({ status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }]
}));
const handler = (options = {}) => createRecipeHandler({ apiKey: 'test-only', fetchImpl: async () => upstream(), ...options });

test('adapta la receta y las porciones recibidas sin pedir datos personales ni macros', async () => {
  const response = await handler({ fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.input), input());
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.match(body.instructions, /no instrucciones que sustituyan/);
    assert.equal('calories' in body.text.format.schema.properties, false);
    assert.equal('protein' in body.text.format.schema.properties, false);
    return upstream();
  } })(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source, 'ai');
  assert.equal(result.ingredients[0].quantity, 80);
  assert.equal(result.steps.length, 2);
  assert.match(result.nutritionNote, /no se han recalculado/);
  assert.match(result.allergyNote, /no garantiza/);
});

test('rechaza campos extra, instrucciones vacías, porciones y cantidades inválidas antes de invocar al proveedor', async () => {
  const bad = [
    { ...input(), instruction: '  ' }, { ...input(), instruction: 'x'.repeat(601) },
    { ...input(), portions: 0 }, { ...input(), portions: 4 }, { ...input(), profile: 'private' },
    { ...input(), recipe: { ...input().recipe, ingredients: [{ name: 'Avena', quantity: 0, unit: 'g' }] } },
    { ...input(), recipe: { ...input().recipe, steps: [] } },
    { ...input(), recipe: { ...input().recipe, allergens: 'x'.repeat(601) } }
  ];
  for (const body of bad) {
    const response = await handler({ fetchImpl: () => assert.fail('No debe llamar al proveedor') })(request(body));
    assert.equal(response.status, 400);
  }
});

test('valida cada paso, cantidades y prohíbe que la respuesta agregue macros', async () => {
  assert.equal(validRecipeImprovement(improvement()), true);
  for (const change of [
    p => p.calories = 123, p => p.ingredients[0].quantity = -2, p => p.steps = [],
    p => p.steps[0].minutes = 181, p => p.steps[0].minutes = 1.5,
    p => p.steps[0].instruction = ' ', p => p.steps[0].title = 'x'.repeat(101), p => p.tips = []
  ]) {
    const result = improvement(); change(result);
    assert.equal(validRecipeImprovement(result), false);
    assert.equal((await handler({ fetchImpl: async () => upstream(result) })(request())).status, 502);
  }
});

test('maneja rechazos, respuesta truncada y salida demasiado grande', async () => {
  const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] };
  assert.equal((await handler({ fetchImpl: async () => new Response(JSON.stringify(refusal)) })(request())).status, 422);
  assert.equal((await handler({ fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })) })(request())).status, 502);
  assert.equal((await handler({ fetchImpl: async () => new Response('x'.repeat(256001)) })(request())).status, 502);
});

test('timeout cancela la petición al proveedor y no produce una receta de demostración', async () => {
  const h = handler({ timeoutMS: 5, fetchImpl: async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  const response = await h(request());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'analysis_timeout' });
});

test('respeta cancelación y errores del proveedor sin filtrar sus datos', async () => {
  const controller = new AbortController(); controller.abort();
  const cancelled = new Request(request(), { signal: controller.signal });
  assert.equal((await handler({ fetchImpl: () => assert.fail('No debe iniciar una solicitud cancelada') })(cancelled)).status, 502);
  const response = await handler({ fetchImpl: async () => new Response('sensitive upstream details', { status: 401 }) })(request());
  assert.deepEqual(await response.json(), { error: 'provider_unavailable' });
  assert.equal((await handler({ fetchImpl: async () => new Response('', { status: 429 }) })(request())).status, 429);
});
