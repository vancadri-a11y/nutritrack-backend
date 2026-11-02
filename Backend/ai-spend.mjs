export class SpendError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
async function limitedJSON(response, maximum = 512000) {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  return { bytes, payload: JSON.parse(bytes.toString('utf8')) };
}
/** Each paid attempt, including vision corrections, gets its own durable allocation. */
export function createMeteredFetch({ fetchImpl = fetch, quota, identity, reservation,
  maxInputTokens = 40000, maxOutputTokens = 7000, onError = () => {} }) {
  return async (url, options) => {
    try {
      if (url !== 'https://api.openai.com/v1/responses') throw new Error('Unsupported provider');
      const input = JSON.parse(options.body);
      input.max_output_tokens = Math.min(input.max_output_tokens, maxOutputTokens);
      input.service_tier = 'default';
      if (!Number.isInteger(input.max_output_tokens) || input.max_output_tokens < 1) throw new Error('Invalid output limit');
      // Count the complete multimodal prompt, instructions and JSON schema before generation.
      const countRequest = { model: input.model, input: input.input, instructions: input.instructions,
        text: input.text };
      const countResponse = await fetchImpl('https://api.openai.com/v1/responses/input_tokens', {
        ...options, body: JSON.stringify(countRequest)
      });
      if (!countResponse.ok) throw new SpendError('token_count_unavailable', 'No se pudo verificar el tamaño de la solicitud. Inténtalo más tarde.');
      const { payload: count } = await limitedJSON(countResponse, 8192);
      if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens < 0) throw new Error('Invalid token count');
      if (count.input_tokens > maxInputTokens) throw new SpendError('input_token_limit', 'La entrada supera el límite de tokens. Reduce la imagen o las preferencias.', 413);
      const allocation = await quota.reserveSpend(identity, reservation, input.model, count.input_tokens, input.max_output_tokens, options.signal);
      if (!allocation?.allowed) throw new SpendError(allocation?.reason || 'budget_unavailable',
        allocation?.reason === 'budget_exhausted' ? 'Se alcanzó el presupuesto global de IA. Puedes seguir usando el registro manual.' : 'No se pudo autorizar el gasto de IA.', allocation?.reason === 'budget_exhausted' ? 429 : 503);
      if (!allocation.spend_id) throw new Error('Missing spend allocation');
      // Any uncertain outcome keeps the entire allocation charged. Never refund a timeout.
      const response = await fetchImpl(url, { ...options, body: JSON.stringify(input) });
      const { bytes, payload } = await limitedJSON(response);
      const usage = payload.usage;
      if (usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 &&
          Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0) {
        const cached = usage.input_tokens_details?.cached_tokens ?? 0;
        if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.input_tokens) throw new Error('Invalid cached usage');
        await quota.finishSpend(identity, allocation.spend_id, usage.input_tokens, usage.output_tokens, cached, payload.id ?? null);
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    } catch (error) {
      const failure = error instanceof SpendError ? error : new SpendError('budget_unavailable', 'No se pudo confirmar el consumo de IA. Inténtalo más tarde.');
      onError(failure); throw failure;
    }
  };
}
