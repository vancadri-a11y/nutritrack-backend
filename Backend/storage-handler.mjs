import { createHash } from 'node:crypto';

export const STORAGE_BUCKET = 'nutritrack-private';
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHOTO = /^(profile|meal)\/([0-9a-f-]{36})\/([0-9a-f]{64})\.jpg$/;
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extra }
});
export function validPhotoPath(path) {
  const m = typeof path === 'string' && path.match(PHOTO);
  return Boolean(m && UUID.test(m[2]));
}
// Inspect JPEG marker lengths and dimensions before storing. The iOS client also
// decodes/re-encodes photos; never accept an extension or Content-Type as proof.
export function jpegDimensions(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  let p = 2, size = null, scan = false;
  while (p < bytes.length - 2) {
    if (bytes[p++] !== 0xff) return null;
    while (bytes[p] === 0xff) p++;
    const marker = bytes[p++];
    if (marker === 0xd9) break;
    if (marker === 0 || marker === 0xd8 || marker === undefined) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (p + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(p);
    if (length < 2 || p + length > bytes.length) return null;
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(p+3), width = bytes.readUInt16BE(p+5);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) return null;
      size = { width, height };
    }
    p += length;
    if (marker === 0xda) {
      scan = true;
      // Skip entropy bytes, escaped FF and restart markers, then inspect the next segment.
      while (p < bytes.length - 1) {
        if (bytes[p] !== 0xff) { p++; continue; }
        const next = bytes[p+1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { p += 2; continue; }
        break;
      }
    }
  }
  return scan ? size : null;
}
async function boundedBytes(request) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_PHOTO_BYTES) throw new RangeError();
  if (!request.body) throw new TypeError();
  const chunks = []; let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_PHOTO_BYTES) { await reader.cancel(); throw new RangeError(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Caller authenticates once. All Storage and RPC operations retain the user's JWT and RLS. */
export function createStorageHandler({ root, publishableKey, fetchImpl = fetch }) {
  return async (request, user) => {
    if (!UUID.test(user?.id || '') || typeof user.token !== 'string' || !user.token) return json({error:'unauthorized'},401);
    const url = new URL(request.url);
    const rawPath = url.pathname.slice('/v1/storage/'.length);
    const cleanup = rawPath === 'cleanup';
    if ((!cleanup && !validPhotoPath(rawPath)) || url.search) return json({error:'invalid_photo_path'},400);
    const methods = cleanup ? ['POST'] : ['GET','PUT','DELETE'];
    if (!methods.includes(request.method)) return json({error:'method_not_allowed'},405,{Allow:methods.join(', ')});
    const headers = {apikey:publishableKey, Authorization:`Bearer ${user.token}`};
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    const rpc = async (name,data) => {
      const res = await fetchImpl(new URL(`/rest/v1/rpc/${name}`,root), {
        method:'POST', headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data),signal
      });
      if (!res.ok) throw new Error('Storage policy unavailable');
      return await res.json();
    };
    const remove = async names => fetchImpl(new URL(`/storage/v1/object/${STORAGE_BUCKET}`,root), {
      method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefixes:names}),signal
    });
    try {
      if (cleanup) {
        const paths = await rpc('nutritrack_unused_photos',{});
        if (!Array.isArray(paths) || paths.length > 100 || paths.some(p => typeof p !== 'string' || !p.startsWith(`${user.id}/`) || !validPhotoPath(p.slice(37)))) throw new Error();
        if (paths.length && !(await remove(paths)).ok) throw new Error();
        return json({removed:paths.length});
      }
      const object = `${user.id}/${rawPath}`;
      const objectURL = new URL(`/storage/v1/object/${request.method === 'GET' ? 'authenticated/' : ''}${STORAGE_BUCKET}/${object}`,root);
      if (request.method === 'DELETE') {
        if (!(await rpc('nutritrack_photo_can_delete',{p_path:rawPath}))) return json({error:'photo_in_use'},409);
        const res = await remove([object]);
        return res.ok ? json({deleted:true}) : json({error:'storage_unavailable'},503);
      }
      if (request.method === 'PUT') {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') return json({error:'unsupported_photo_type'},415);
        let bytes;
        try { bytes = await boundedBytes(request); } catch (error) { return json({error:'invalid_photo'},error instanceof RangeError?413:400); }
        if (!jpegDimensions(bytes) || createHash('sha256').update(bytes).digest('hex') !== rawPath.match(PHOTO)[3]) return json({error:'invalid_photo'},400);
        // POST without upsert preserves immutable content-addressed versions.
        const res = await fetchImpl(objectURL,{method:'POST',headers:{...headers,'Content-Type':'image/jpeg','x-upsert':'false','Cache-Control':'private, no-store'},body:bytes,signal});
        if (res.ok) return json({path:rawPath},201);
        const error = await res.json().catch(()=>null);
        // Supabase reports a duplicate as 409 or statusCode 409. Verify bytes
        // through the JWT-protected read before acknowledging an existing object.
        if (res.status === 409 || String(error?.statusCode) === '409' || error?.error === 'Duplicate') {
          const existing = await fetchImpl(new URL(`/storage/v1/object/authenticated/${STORAGE_BUCKET}/${object}`,root),{headers,signal});
          if (existing.ok && Number(existing.headers.get('content-length') || 0) <= MAX_PHOTO_BYTES) {
            const prior = Buffer.from(await existing.arrayBuffer());
            if (prior.length <= MAX_PHOTO_BYTES && createHash('sha256').update(prior).digest('hex') === rawPath.match(PHOTO)[3]) return json({path:rawPath});
          }
        }
        return json({error:'storage_unavailable'},503);
      }
      const res = await fetchImpl(objectURL,{headers,signal});
      if (!res.ok) return json({error:res.status === 404?'photo_not_found':'storage_unavailable'},res.status===404?404:503);
      const bytes = await boundedBytes(new Request(request.url,{method:'POST',body:res.body,duplex:'half',headers:res.headers}));
      if (!jpegDimensions(bytes) || createHash('sha256').update(bytes).digest('hex') !== rawPath.match(PHOTO)[3]) return json({error:'invalid_stored_photo'},503);
      return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    } catch { return json({error:'storage_unavailable'},503); }
  };
}
