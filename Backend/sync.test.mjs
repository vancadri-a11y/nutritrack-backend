import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBackend } from './supabase-backend.mjs';
import { validateSyncChanges } from './sync-validation.mjs';
const id='11111111-1111-4111-8111-111111111111', token='a'.repeat(40);
const item={key:'water:'+id,base_version:0,deleted:false,payload:{id,recordedAt:800000000,milliliters:250}};
const json=data=>new Response(JSON.stringify(data));
test('Sync uses verified JWT, isolates ownership and paginates with an account revision',async()=>{
  const calls=[];
  const h=createSupabaseBackend({supabaseURL:'https://test.supabase.co',publishableKey:'public',fetchImpl:async(url,opts)=>{
    calls.push({url,opts});if(url.pathname==='/auth/v1/user')return json({id});
    return json(url.pathname.endsWith('nutritrack_sync')?{results:[]} : {items:[],next_cursor:0,until:0,has_more:false});
  }});
  const req=(path,method='GET',data)=>h(new Request('https://api.test'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined}));
  assert.equal((await req('/v1/sync?after=12&until=24')).status,200);
  assert.deepEqual(JSON.parse(calls.at(-1).opts.body),{p_after:12,p_until:24,p_limit:50});
  assert.equal(calls.at(-1).opts.headers.Authorization,'Bearer '+token);
  assert.equal((await req('/v1/sync','POST',{items:[item]})).status,200);
  assert.deepEqual(JSON.parse(calls.at(-1).opts.body),{p_items:[item]});
  assert.equal((await req('/v1/sync','POST',{items:[item],user_id:id})).status,400);
  assert.equal((await req('/v1/sync?after=evil)')).status,400);
  assert.equal((await h(new Request('https://api.test/v1/sync'))).status,401);
});
test('Sync rejects photos, forged ownership, duplicate keys and invalid tombstones',()=>{
  assert.deepEqual(validateSyncChanges({items:[item]}),[item]);
  for(const bad of [{...item,payload:{...item.payload,imageData:'photo'}},{...item,user_id:id},{...item,payload:{...item.payload,id:'different'}},{...item,base_version:-1},{...item,deleted:true},{...item,key:'unknown:'+id},{...item,payload:{...item.payload,milliliters:0}}])assert.throws(()=>validateSyncChanges({items:[bad]}));
  assert.throws(()=>validateSyncChanges({items:[item,item]}));
  assert.doesNotThrow(()=>validateSyncChanges({items:[{...item,deleted:true,payload:null}]}));
});
