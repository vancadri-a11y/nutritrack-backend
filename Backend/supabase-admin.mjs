/** Admin capabilities are isolated from ordinary RLS-protected data calls. */
export function createSupabaseAdmin({ root, secretKey, fetchImpl = fetch }) {
  const configured = typeof secretKey === 'string' && (secretKey.startsWith('sb_secret_') || secretKey.startsWith('eyJ'));
  const call = async (path, { method = 'POST', data, signal } = {}) => {
    if (!configured) throw new Error('Admin not configured');
    const response = await fetchImpl(new URL(path, root), {
      method, headers: { apikey: secretKey, ...(!secretKey.startsWith('sb_secret_') ? { Authorization: `Bearer ${secretKey}` } : {}),
        'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Administrative operation failed');
    return response.status === 204 ? null : await response.json();
  };
  const rpc = (name, data, signal) => call(`/rest/v1/rpc/${name}`, { data, signal });
  return {
    configured,
    usage: user => rpc('nutritrack_usage', { p_user_id: user.id }),
    reserve: (user, key, fingerprint, signal) => rpc('nutritrack_reserve_ai',
      { p_user_id: user.id, p_request_key: key, p_fingerprint: fingerprint }, signal),
    finish: (user, reservation, result) => rpc('nutritrack_finish_ai',
      { p_user_id: user.id, p_reservation_id: reservation, p_result: result }),
    async deleteAccount(user) {
      const objects = await rpc('nutritrack_owned_objects', { p_user_id: user.id });
      if (!Array.isArray(objects)) throw new Error('Invalid storage listing');
      const buckets = new Map();
      for (const object of objects) {
        if (typeof object.bucket !== 'string' || typeof object.name !== 'string') throw new Error('Invalid object');
        if (!buckets.has(object.bucket)) buckets.set(object.bucket, []);
        buckets.get(object.bucket).push(object.name);
      }
      for (const [bucket, names] of buckets) {
        for (let i=0; i<names.length; i+=100) {
          await call(`/storage/v1/object/${encodeURIComponent(bucket)}`, { method:'DELETE', data:{ prefixes:names.slice(i,i+100) } });
        }
      }
      await call(`/auth/v1/admin/users/${user.id}`, { method:'DELETE', data:{ should_soft_delete:false } });
    }
  };
}
