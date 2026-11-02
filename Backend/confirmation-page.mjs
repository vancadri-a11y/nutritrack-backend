import { randomUUID } from 'node:crypto';

/** Landing page only: Supabase verifies the email before redirecting here. */
export function confirmationPage() {
  const nonce = randomUUID();
  return new Response(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NutriTrackAI · Verificación</title>
<style nonce="${nonce}">
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#f0f5ef;color:#172c22;font-family:system-ui,sans-serif}
main{max-width:420px;margin:24px;padding:36px;background:white;border-radius:28px;box-shadow:0 15px 60px #173a2210;text-align:center}
.brand{font-weight:700;color:#146647}h1{font-size:30px;line-height:1.15}p{line-height:1.6;color:#52645b}.hint{font-size:14px}
</style></head><body><main><div class="brand">NutriTrackAI</div><h1 id="title">Vuelve a la app</h1>
<p id="message">Abre NutriTrackAI, selecciona Iniciar sesión y utiliza el correo y la contraseña con los que creaste tu cuenta.</p>
<p class="hint">La app comprobará que tu correo esté confirmado al iniciar sesión.</p></main>
<script nonce="${nonce}">
const fragment = new URLSearchParams(location.hash.slice(1));
const query = new URLSearchParams(location.search);
if (fragment.has('error') || fragment.has('error_code') || query.has('error') || query.has('error_code')) {
 document.getElementById('title').textContent = 'No se pudo confirmar el enlace';
 document.getElementById('message').textContent = 'El enlace puede haber caducado o haberse utilizado. Si ya confirmaste tu correo, intenta iniciar sesión en la app.';
}
// Do not persist, transmit, or display tokens from the email redirect.
history.replaceState(null, '', location.pathname);
</script></body></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  }});
}
