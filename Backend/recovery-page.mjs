import { randomUUID } from 'node:crypto';

export function recoveryPage() {
  const nonce = randomUUID();
  return new Response(`<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NutriTrackAI · Nueva contraseña</title>
<style nonce="${nonce}">
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#eef5ef;color:#17392b;font-family:system-ui,sans-serif}
main{width:min(420px,calc(100% - 80px));margin:24px;padding:28px;background:white;border-radius:28px}
label,input,button,a{display:block}[hidden]{display:none!important}input{box-sizing:border-box;width:100%;padding:14px;margin:8px 0 18px;border:1px solid #adbfb2;border-radius:12px;font:inherit}
button,a{padding:14px;background:#176b49;color:white;border:0;border-radius:12px;font:inherit;text-align:center;text-decoration:none}a{margin:18px 0}p{line-height:1.5}button:disabled{opacity:.5}
</style></head><body><main><h1>Nueva contraseña</h1>
<p>Abre NutriTrackAI para cambiarla o completa el formulario aquí. Usa al menos 12 caracteres.</p>
<a id="open" hidden>Abrir NutriTrackAI</a>
<form id="form"><label for="password">Contraseña nueva</label><input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required>
<label for="repeat">Repetir contraseña</label><input id="repeat" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required>
<button id="save" type="submit">Guardar contraseña</button></form><p id="message" role="status"></p>
</main><script nonce="${nonce}">
const query=new URLSearchParams(location.search), fragment=new URLSearchParams(location.hash.slice(1));
const link=new URLSearchParams();
let accessToken=null;
if(query.get('type')==='recovery'&&/^[A-Za-z0-9_-]{20,256}$/.test(query.get('token_hash')||'')) {
 link.set('token_hash',query.get('token_hash'));link.set('type','recovery');
} else if(fragment.get('type')==='recovery'&&fragment.get('access_token')) {
 for(const key of ['access_token','refresh_token','expires_in','type']) if(fragment.has(key))link.set(key,fragment.get(key));
 accessToken=fragment.get('access_token');
}
// Keep recovery credentials in memory only, never localStorage or logs.
history.replaceState(null,'',location.pathname);
const message=document.getElementById('message'), save=document.getElementById('save');
if(link.has('type')) {
 const open=document.getElementById('open');open.hidden=false;open.href='nutritrack://auth/recovery#'+link.toString();
} else {save.disabled=true;message.textContent='El enlace no es válido o caducó. Solicita otro desde la app.';}
async function api(path, data, token, method='POST') {
 const response=await fetch(path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data),cache:'no-store',credentials:'omit',redirect:'error'});
 const payload=await response.json();if(!response.ok)throw new Error(payload.message||'El enlace caducó o ya se utilizó. Solicita otro.');return payload;
}
document.getElementById('form').addEventListener('submit',async event=>{
 event.preventDefault();const password=document.getElementById('password').value;
 if(password!==document.getElementById('repeat').value){message.textContent='Las contraseñas no coinciden.';return;}
 if(password.length<12){message.textContent='Usa al menos 12 caracteres.';return;}
 save.disabled=true;message.textContent='Guardando…';
 try {
  if(!accessToken){const session=await api('/v1/auth/recovery/verify',{token_hash:link.get('token_hash')});accessToken=session.access_token;}
  await api('/v1/auth/password',{password},accessToken,'PUT');
  try{await api('/v1/auth/logout',{},accessToken);}catch{}
  accessToken=null;document.getElementById('form').hidden=true;document.getElementById('open').hidden=true;
  message.textContent='Contraseña actualizada. Vuelve a NutriTrackAI e inicia sesión.';
 }catch(error){message.textContent=error.message;save.disabled=false;}
});
</script></body></html>`,{headers:{
    'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  }});
}
