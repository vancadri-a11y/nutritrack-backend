import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBackend } from './supabase-backend.mjs';
import { createAPIHandler } from './api-handler.mjs';

const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const token='a'.repeat(40), secret='sb_secret_server_only';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const usage={limit:5,used:5,remaining:0,global_remaining:100,resets_at:'2099-01-01T07:00:00Z'};
const session={access_token:token,refresh_token:'refresh',expires_in:3600,user:{id,email:'ana@example.com'}};
function setup(extra={}) {
  const calls=[];
  const h=createSupabaseBackend({supabaseURL:'https://example.supabase.co',publishableKey:'sb_publishable_test',secretKey:secret,
    recoveryRedirectURL:'https://api.example.com/auth/recovery',apiKey:'provider-secret',
    fetchImpl:async(url,opts)=>{
      calls.push({url:String(url),...opts});
      if(extra.fetch) return extra.fetch(url,opts);
      if(url.pathname==='/auth/v1/user') return opts.headers.Authorization===`Bearer ${token}` ? json({id,email:'ana@example.com'}) : json({},401);
      if(url.pathname==='/auth/v1/recover') return json({});
      if(url.pathname==='/auth/v1/verify') return json(session);
      if(url.pathname==='/rest/v1/rpc/nutritrack_usage') return json(usage);
      if(url.pathname==='/rest/v1/rpc/nutritrack_owned_objects') return json([{bucket:'photos',name:'ana/meal.jpg'}]);
      if(url.pathname.startsWith('/storage/v1/object/')||url.pathname.startsWith('/auth/v1/admin/users/')) return json({});
      throw new Error('Unexpected upstream');
    }});
  const request=(path,{method='GET',data,authenticated=true}={})=>h(new Request('https://api.example.com'+path,{
    method,headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${token}`}:{})},
    body:data===undefined?undefined:JSON.stringify(data)}));
  return {request,calls};
}
test('Recovery uses only configured redirect, token verification forces recovery type',async()=>{
  const {request,calls}=setup();
  assert.equal((await request('/v1/auth/recover',{method:'POST',data:{email:'ana@example.com',redirect_to:'https://evil.example'}})).status,200);
  assert.equal(new URL(calls[0].url).searchParams.get('redirect_to'),'https://api.example.com/auth/recovery');
  await request('/v1/auth/recovery/verify',{method:'POST',data:{token_hash:'a'.repeat(64),type:'signup'}});
  assert.deepEqual(JSON.parse(calls.at(-1).body),{token_hash:'a'.repeat(64),type:'recovery'});
  assert.equal((await request('/v1/auth/recovery/verify',{method:'POST',data:{token_hash:'<script>'}})).status,400);
});
test('Expired recovery token never yields a session',async()=>{
  const {request}=setup({fetch:async()=>json({code:'otp_expired',internal:'PRIVATE'},403)});
  const r=await request('/v1/auth/recovery/verify',{method:'POST',data:{token_hash:'a'.repeat(64)}});
  assert.equal(r.status,400);assert.ok(!(await r.text()).includes('PRIVATE'));
});
test('Password update requires valid identity, strong password and uses user JWT, never admin',async()=>{
  const {request,calls}=setup({fetch:async(url,opts)=>url.pathname==='/auth/v1/user'&&opts.method==='GET'?json({id}):json({})});
  assert.equal((await request('/v1/auth/password',{method:'PUT',data:{password:'long-password-123'}})).status,200);
  assert.equal(calls.at(-1).headers.apikey,'sb_publishable_test');assert.equal(calls.at(-1).headers.Authorization,`Bearer ${token}`);
  assert.equal((await request('/v1/auth/password',{method:'PUT',data:{password:'short'}})).status,400);
  assert.equal((await request('/v1/auth/password',{method:'PUT',data:{password:'long-password-123',user_id:other}})).status,400);
  assert.equal((await request('/v1/auth/password',{method:'GET'})).status,405);
});
test('Deletion requires confirmation and verified identity, removes files before own user',async()=>{
  const {request,calls}=setup();
  assert.equal((await request('/v1/account',{method:'DELETE',data:{confirmation:'DELETE'},authenticated:false})).status,401);
  assert.equal((await request('/v1/account',{method:'DELETE',data:{confirmation:'DELETE',user_id:other}})).status,400);
  assert.equal((await request('/v1/account',{method:'DELETE',data:{}})).status,400);
  assert.equal((await request('/v1/account',{method:'DELETE',data:{confirmation:'DELETE'}})).status,200);
  const administrative=calls.filter(c=>c.headers.apikey===secret);
  assert.ok(administrative.every(c=>!c.headers.Authorization));
  assert.ok(administrative.at(-1).url.endsWith('/auth/v1/admin/users/'+id));
  assert.deepEqual(JSON.parse(administrative.at(-2).body),{prefixes:['ana/meal.jpg']});
});
test('Storage deletion failure blocks identity deletion and leaks no secrets',async()=>{
  const {request,calls}=setup({fetch:async(url)=>{
    if(url.pathname==='/auth/v1/user')return json({id});
    if(url.pathname.endsWith('nutritrack_owned_objects'))return json([{bucket:'photos',name:'ana/a.jpg'}]);
    return json({message:secret},500);
  }});
  const r=await request('/v1/account',{method:'DELETE',data:{confirmation:'DELETE'}});
  assert.equal(r.status,503);assert.ok(!(await r.text()).includes(secret));
  assert.ok(!calls.some(c=>c.url.includes('/admin/users/')));
});
test('Usage endpoint uses verified identity; recovery page protects tokens and remains public',async()=>{
  const {request,calls}=setup();
  assert.equal((await request('/v1/usage',{authenticated:false})).status,401);
  assert.deepEqual(await (await request('/v1/usage?user_id='+other)).json(),usage);
  assert.deepEqual(JSON.parse(calls.at(-1).body),{p_user_id:id});
  const page=await request('/auth/recovery',{authenticated:false});
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.ok(page.headers.get('content-security-policy').includes("connect-src 'self'"));
  const html=await page.text();assert.ok(html.includes('history.replaceState'));assert.ok(html.includes('nutritrack://auth/recovery#'));
});
test('Missing admin credential fails closed for quotas and deletion, keeps authentication working',async()=>{
  const h=createSupabaseBackend({supabaseURL:'https://example.supabase.co',publishableKey:'public',fetchImpl:async()=>json({id})});
  const r=await h(new Request('https://api.example.com/v1/usage',{headers:{Authorization:`Bearer ${token}`}}));
  assert.equal(r.status,503);
});
const estimate={is_food:true,summary:'Plato',calories:520,protein:35,carbs:59,fat:16,confidence:'medium',notes:'Estimación.'};
const aiRequest=(key='request-0000000001')=>new Request('https://api.example.com/v1/food/analyze',{method:'POST',
  headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({image_base64:Buffer.from([255,216,255,224,255,217]).toString('base64'),mime_type:'image/jpeg',prompt_version:'food-v1'})});
test('Quota exhaustion and database failures prevent any provider call',async()=>{
  for(const reserve of [async()=>({allowed:false,reason:'user_quota',usage}),async()=>{throw new Error('db');}]) {
    let calls=0;
    const h=createAPIHandler({apiKey:'key',authenticate:async()=>({id}),quota:{reserve},fetchImpl:async()=>{calls++;return json({});}});
    const response=await h(aiRequest());assert.ok([429,503].includes(response.status));assert.equal(calls,0);
  }
});
test('Quota reservation precedes provider and persistent replay avoids another provider call',async()=>{
  const order=[];let saved=null;
  const quota={reserve:async()=>{order.push('reserve');return saved?{allowed:false,reason:'duplicate',state:'completed',result:saved}:{allowed:true,reservation_id:id};},
    finish:async(user,reservation,result)=>{order.push('finish');saved=result;}};
  const options={apiKey:'key',authenticate:async()=>({id}),quota,fetchImpl:async()=>{order.push('provider');return json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(estimate)}]}]});}};
  assert.equal((await createAPIHandler(options)(aiRequest())).status,200);
  assert.deepEqual(order,['reserve','provider','finish']);
  assert.equal((await createAPIHandler(options)(aiRequest())).status,200);
  assert.equal(order.filter(v=>v==='provider').length,1);
});
test('Failed reservation remains charged; duplicate explains failure and new explicit attempt reserves again',async()=>{
  const reservations=new Map();let providerCalls=0;
  const quota={reserve:async(user,key)=>{
    if(reservations.has(key))return {allowed:false,reason:'duplicate',state:reservations.get(key).state};
    reservations.set(key,{state:'reserved'});return {allowed:true,reservation_id:key};
  },finish:async(user,key,result)=>{reservations.get(key).state=result?'completed':'failed';}};
  const options={apiKey:'key',authenticate:async()=>({id}),quota,fetchImpl:async()=>{
    providerCalls++;
    if(providerCalls===1)return json({},500);
    return json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(estimate)}]}]});
  }};
  assert.ok(!(await createAPIHandler(options)(aiRequest())).ok);
  const replay=await createAPIHandler(options)(aiRequest());
  assert.equal(replay.status,409);assert.equal((await replay.json()).error,'analysis_failed');
  assert.equal(providerCalls,1);assert.equal(reservations.size,1);
  assert.equal((await createAPIHandler(options)(aiRequest('request-0000000002'))).status,200);
  assert.equal(providerCalls,2);assert.equal(reservations.size,2);
});
