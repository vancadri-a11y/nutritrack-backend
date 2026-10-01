import { validFoodContext, analysisSchema, validAnalysis, scalePortion, contextInstructions } from './food-context.mjs';
import { readFileSync } from 'node:fs';

export const SYSTEM_PROMPT = readFileSync(
  new URL('../Shared/food-analysis-system-prompt.txt', import.meta.url), 'utf8'
).trim();

export const responseSchema = {
  type: 'object', additionalProperties: false,
  required: ['is_food', 'summary', 'calories', 'protein', 'carbs', 'fat', 'confidence', 'notes'],
  properties: {
    is_food: { type: 'boolean' },
    summary: { type: 'string', maxLength: 160 },
    calories: { type: 'number', minimum: 0, maximum: 10000 },
    protein: { type: 'number', minimum: 0, maximum: 1000 },
    carbs: { type: 'number', minimum: 0, maximum: 1000 },
    fat: { type: 'number', minimum: 0, maximum: 1000 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string', maxLength: 1000 }
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export function validEstimate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = responseSchema.required;
  return Object.keys(value).length === keys.length && keys.every(key => key in value)
    && typeof value.is_food === 'boolean'
    && typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 160
    && typeof value.notes === 'string' && value.notes.length <= 1000
    && ['low', 'medium', 'high'].includes(value.confidence)
    && Number.isFinite(value.calories) && value.calories >= 0 && value.calories <= 10000
    && ['protein', 'carbs', 'fat'].every(key =>
      Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1000);
}

export function buildProviderRequest(imageBase64, model, context = null) {
  const schema = context ? { ...responseSchema, required: [...responseSchema.required, 'analysis'], properties: { ...responseSchema.properties, analysis: analysisSchema } } : responseSchema;
  return {
    model,
    store: false,
    instructions: context ? SYSTEM_PROMPT.replaceAll("food_analysis_v1", "food_analysis_v2").replace("Usa exactamente estas claves:", "Las claves base son:") + contextInstructions : SYSTEM_PROMPT,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Estima los nutrientes de toda la porción visible.' + (context ? '\nDatos de la porción: ' + JSON.stringify({ measuredGrams: context.measuredGrams ?? null, notes: context.notes }) : '') },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' }
      ]
    }],
    text: { format: { type: 'json_schema', name: context ? 'food_analysis_v2' : 'food_analysis_v1', strict: true, schema } },
    max_output_tokens: context ? 3500 : 1200
  };
}

async function readLimitedJSON(request) {
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2800000) { await reader.cancel(); throw new RangeError('large'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Handler portable Request -> Response.
 * authenticate debe validar la sesión del usuario en el servidor.
 * Inyecta rate limiting/cuotas por usuario en esa capa antes de llamar al proveedor.
 * No registra cuerpos, fotos, tokens ni respuestas del proveedor.
 */
export function createVisionHandler({ apiKey, model = 'gpt-4o-mini', authenticate, fetchImpl = fetch, timeoutMS = 40000 }) {
  if (!apiKey || typeof authenticate !== 'function') throw new Error('Faltan credenciales o autenticación.');
  return async function handle(request) {
    if (new URL(request.url).pathname !== '/v1/food/analyze') return json({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    let authenticated = false;
    try { authenticated = await authenticate(request); } catch { /* No revelar detalles de sesión. */ }
    if (!authenticated) return json({ error: 'unauthorized' }, 401);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return json({ error: 'unsupported_media_type' }, 415);
    }
    let body;
    try { body = await readLimitedJSON(request); }
    catch (error) { return json({ error: 'invalid_request' }, error instanceof RangeError ? 413 : 400); }
    if (!body || !['food-v1', 'food-v2'].includes(body.prompt_version) || body.mime_type !== 'image/jpeg'
        || typeof body.image_base64 !== 'string' || body.image_base64.length > 2666668
        || body.image_base64.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.image_base64)) {
      return json({ error: 'invalid_image' }, 400);
    }
    const context = body.prompt_version === 'food-v2' ? body.context : null;
    if (body.prompt_version === 'food-v2' && !validFoodContext(context)) return json({ error: 'invalid_context' }, 400);
    const bytes = Buffer.from(body.image_base64, 'base64');
    if (bytes.length > 2000000) return json({ error: 'image_too_large' }, 413);
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return json({ error: 'invalid_image' }, 400);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMS);
    const cancel = () => controller.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) controller.abort();
    try {
      const upstream = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildProviderRequest(body.image_base64, model, context)),
        signal: controller.signal
      });
      if (!upstream.ok) return json({ error: 'provider_unavailable' }, upstream.status === 429 ? 429 : 502);
      const reader = upstream.body?.getReader();
      if (!reader) return json({ error: 'invalid_analysis' }, 502);
      const parts = []; let responseSize = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        responseSize += value.byteLength;
        if (responseSize > 512000) { await reader.cancel(); return json({ error: 'invalid_analysis' }, 502); }
        parts.push(Buffer.from(value));
      }
      const response = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (response.status !== 'completed' || !Array.isArray(response.output)) return json({ error: 'incomplete_analysis' }, 502);
      // HTTP crudo: output_text del SDK no es un campo que debamos asumir en el JSON.
      const content = (response.output ?? []).filter(item => item.type === 'message')
        .flatMap(item => Array.isArray(item.content) ? item.content : []);
      if (content.some(item => item.type === 'refusal')) return json({ error: 'analysis_unavailable' }, 502);
      const text = content.filter(item => item.type === 'output_text').map(item => item.text).join('');
      let result;
      try { result = JSON.parse(text); } catch { return json({ error: 'invalid_analysis' }, 502); }
      const { analysis, ...base } = result ?? {};
      if (context && !validAnalysis(result, context)) return json({ error: 'invalid_analysis' }, 502);
      if (!validEstimate(context ? base : result)) return json({ error: 'invalid_analysis' }, 502);
      if (!result.is_food) return json({ error: 'no_food' }, 422);
      return json(context ? scalePortion(result, context.consumedFraction) : result);
    } catch {
      return json({ error: controller.signal.aborted ? 'analysis_timeout' : 'provider_unavailable' }, 502);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', cancel);
    }
  };
}
