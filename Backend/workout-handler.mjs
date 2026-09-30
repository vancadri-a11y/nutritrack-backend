import { randomUUID } from 'node:crypto';

export const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
export const workoutSchema = {
  type: 'object', additionalProperties: false, required: ['sessions'],
  properties: { sessions: {
    type: 'array', minItems: 7, maxItems: 7,
    items: { type: 'object', additionalProperties: false, required: ['day', 'title', 'minutes', 'exercises'],
      properties: {
        day: { type: 'string', enum: days }, title: text(100),
        minutes: { type: 'integer', minimum: 0, maximum: 60 },
        exercises: { type: 'array', minItems: 1, maxItems: 10, items: text(300) }
      }
    }
  } }
};
export function validWorkoutInput(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 4
    && Number.isInteger(value.age) && value.age >= 18 && value.age <= 100
    && ['maintain', 'loseFat', 'buildMuscle'].includes(value.goal)
    && ['sedentary', 'light', 'moderate'].includes(value.activity)
    && Number.isInteger(value.minutes) && value.minutes >= 10 && value.minutes <= 60;
}
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function validWorkout(value, maximumMinutes = 60) {
  return value && Object.keys(value).length === 1 && Array.isArray(value.sessions) && value.sessions.length === 7
    && value.sessions.every((s, i) => s && Object.keys(s).length === 4 && s.day === days[i]
      && validText(s.title, 100) && Number.isInteger(s.minutes) && s.minutes >= 0 && s.minutes <= maximumMinutes
      && Array.isArray(s.exercises) && s.exercises.length >= 1 && s.exercises.length <= 10
      && s.exercises.every(e => validText(e, 300)))
    && value.sessions.some(s => s.minutes === 0) && value.sessions.some(s => s.minutes > 0);
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Internal provider adapter: the public API wrapper supplies authentication, quotas and body limits.
export function createWorkoutHandler({ apiKey, model = 'gpt-4o-mini', fetchImpl = fetch, timeoutMS = 40000 }) {
  return async request => {
    let input;
    try { input = await request.json(); } catch { return json({ error: 'invalid_workout_request' }, 400); }
    if (!validWorkoutInput(input)) return json({ error: 'invalid_workout_request' }, 400);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, timeoutMS);
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) cancel();
    try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, store: false,
          instructions: 'Genera en español una propuesta general de movimiento para una persona adulta. Siete días ordenados de lunes a domingo; al menos un día de descanso con minutes=0 y al menos uno activo. Respeta el máximo de minutos solicitado. Usa ejercicios sin equipamiento especial y de bajo impacto; adapta a edad y actividad. Incluye calentamiento, instrucciones claras, series o duración y recuperación dentro de exercises. No diagnostiques, no prometas pérdida de peso ni estimes calorías quemadas. Indica detenerse si hay dolor. No es rehabilitación ni prescripción médica.',
          input: JSON.stringify(input), max_output_tokens: 3500,
          text: { format: { type: 'json_schema', name: 'workout_week_v1', strict: true, schema: workoutSchema } }
        })
      });
      if (!response.ok) return json({ error: 'provider_unavailable' }, response.status === 429 ? 429 : 502);
      const reader = response.body?.getReader();
      if (!reader) return json({ error: 'invalid_workout' }, 502);
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512000) { await reader.cancel(); return json({ error: 'invalid_workout' }, 502); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data.status !== 'completed' || !Array.isArray(data.output)) return json({ error: 'invalid_workout' }, 502);
      const content = data.output.filter(o => o.type === 'message').flatMap(o => Array.isArray(o.content) ? o.content : []);
      if (content.some(c => c.type === 'refusal')) return json({ error: 'invalid_workout' }, 502);
      let result;
      try { result = JSON.parse(content.filter(c => c.type === 'output_text').map(c => c.text).join('')); }
      catch { return json({ error: 'invalid_workout' }, 502); }
      if (!validWorkout(result, input.minutes)) return json({ error: 'invalid_workout' }, 502);
      return json({ source: 'ai', sessions: result.sessions.map(s => ({ id: randomUUID(), ...s })) });
    } catch {
      return json({ error: controller.signal.aborted ? 'analysis_timeout' : 'provider_unavailable' }, 502);
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); }
  };
}
