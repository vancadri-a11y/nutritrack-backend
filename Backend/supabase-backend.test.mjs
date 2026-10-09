import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBackend } from './supabase-backend.mjs';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const tokens = { [a]: 'a'.repeat(40), [b]: 'b'.repeat(40) };
const res = (data, status = 200) => new Response(JSON.stringify(data), { status });
function setup() {
  const calls = []; const meals = new Map();
  const handler = createSupabaseBackend({ supabaseURL: 'https://example.supabase.co', publishableKey: 'sb_publishable_test',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      const user = Object.keys(tokens).find(id => options.headers.Authorization === `Bearer ${tokens[id]}`);
      if (url.pathname === '/auth/v1/user') return user ? res({ id: user, email: 'user@example.com' }) : res({}, 401);
      if (url.pathname === '/auth/v1/token' || url.pathname === '/auth/v1/signup') return res({ access_token: tokens[a], refresh_token: 'refresh', expires_in: 3600, user: { id: a, email: 'user@example.com' }, internal: 'never forward' });
      if (url.pathname === '/rest/v1/meals') {
        if (options.method === 'POST') {
          const data = JSON.parse(options.body);
          assert.equal(data.user_id, user); meals.set(`${user}:${data.id}`, data); return res([data]);
        }
        assert.equal(url.searchParams.get('user_id'), `eq.${user}`);
        const visible = [...meals.values()].filter(m => m.user_id === user && (!url.searchParams.has('id') || url.searchParams.get('id') === `eq.${m.id}`));
        if (options.method === 'DELETE') for (const m of visible) meals.delete(`${user}:${m.id}`);
        return res(visible);
      }
      if (url.pathname === '/rest/v1/profiles') return res([JSON.parse(options.body)]);
      throw new Error('Unexpected upstream');
    } });
  const request = (path, { user, method = 'GET', data } = {}) => handler(new Request(`https://api.example.com${path}`, {
    method, headers: { ...(user ? { Authorization: `Bearer ${tokens[user]}` } : {}), 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data) }));
  return { request, calls };
}
const meal = { id: '33333333-3333-4333-8333-333333333333', title: 'Pollo', recorded_at: '2026-10-08T12:00:00Z',
  meal_type: 'comida', origin: 'manual', calories: 500, protein: 35, carbs: 50, fat: 15 };
test('Login issues individual sessions without provider secrets', async () => {
  const { request } = setup(); const result = await request('/v1/auth/login', { method: 'POST', data: { email: 'user@example.com', password: 'password' } });
  assert.equal(result.status, 200); const payload = await result.json();
  assert.equal(payload.access_token, tokens[a]); assert.equal(payload.user.id, a); assert.equal(payload.internal, undefined);
});
test('Registration validates password and refresh forwards only the refresh token', async () => {
  const { request, calls } = setup();
  assert.equal((await request('/v1/auth/register', { method: 'POST', data: { email: 'user@example.com', password: 'short' } })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await request('/v1/auth/refresh', { method: 'POST', data: { refresh_token: 'refresh', user_id: b } })).status, 200);
  assert.deepEqual(JSON.parse(calls[0].body), { refresh_token: 'refresh' });
});
test('Missing or forged session cannot read meals or recipes', async () => {
  const { request } = setup();
  for (const path of ['/v1/meals', '/v1/profile', '/v1/recipes']) assert.equal((await request(path)).status, 401);
});
test('Two users have separate histories and cannot delete each other\'s meal', async () => {
  const { request } = setup();
  assert.equal((await request('/v1/meals', { user: a, method: 'POST', data: meal })).status, 200);
  assert.deepEqual(await (await request('/v1/meals', { user: b })).json(), []);
  assert.deepEqual(await (await request(`/v1/meals/${meal.id}`, { user: b, method: 'DELETE' })).json(), []);
  assert.equal((await (await request('/v1/meals', { user: a })).json()).length, 1);
  await request('/v1/meals', { user: b, method: 'POST', data: { ...meal, title: 'Arroz' } });
  assert.equal((await (await request('/v1/meals', { user: a })).json())[0].title, 'Pollo');
});
test('Ownership injection, invalid nutrition, unbounded pagination and large bodies rejected', async () => {
  const { request } = setup();
  for (const data of [{ ...meal, user_id: b }, { ...meal, calories: -1 }, { ...meal, notes: 'a'.repeat(40000) }]) {
    assert.equal((await request('/v1/meals', { user: a, method: 'POST', data })).status, 400);
  }
  assert.equal((await request('/v1/meals?limit=100000', { user: a })).status, 400);
  assert.equal((await request('/v1/profile', { user: a, method: 'PATCH', data: { user_id: b } })).status, 400);
});
test('Data requests preserve user JWT and publishable key so RLS stays enforced', async () => {
  const { request, calls } = setup();
  await request('/v1/profile', { user: a, method: 'PATCH', data: { name: 'Ana', height_cm: 170 } });
  const last = calls.at(-1); assert.equal(last.headers.Authorization, `Bearer ${tokens[a]}`);
  assert.equal(last.headers.apikey, 'sb_publishable_test'); assert.equal(JSON.parse(last.body).user_id, a);
});
test('Upstream failures fail closed without leaking credentials or database errors', async () => {
  const h = createSupabaseBackend({ supabaseURL: 'https://example.supabase.co', publishableKey: 'public', fetchImpl: async () => { throw new Error('SECRET'); } });
  const result = await h(new Request('https://api.example.com/v1/meals', { headers: { Authorization: `Bearer ${tokens[a]}` } }));
  assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('SECRET'));
});
test('Auth failures expose only allowlisted codes and safe messages', async () => {
  for (const code of ['email_address_not_authorized', 'weak_password', 'unknown_private_error']) {
    const h = createSupabaseBackend({ supabaseURL: 'https://example.supabase.co', publishableKey: 'public',
      fetchImpl: async () => res({ code, msg: 'SECRET INTERNAL DETAIL' }, 400) });
    const result = await h(new Request('https://api.example.com/v1/auth/register', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'long-password-123' }) }));
    const payload = await result.json();
    assert.equal(payload.error, code === 'unknown_private_error' ? 'request_rejected' : code);
    assert.ok(!payload.message.includes('SECRET'));
  }
});
