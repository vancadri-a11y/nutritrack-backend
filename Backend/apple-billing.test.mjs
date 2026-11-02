import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppleBilling, BillingError, appleBillingConfiguration } from './apple-billing.mjs';
import { createAPIHandler } from './api-handler.mjs';
import { Environment, Type, Status } from '@apple/app-store-server-library';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const user={id:'11111111-1111-4111-8111-111111111111'}, other='22222222-2222-4222-8222-222222222222';
const time=Date.parse('2030-01-01T00:00:00Z');
function fixture() {
  const tx={bundleId:'com.example.NutriTrackAI',environment:'Sandbox',productId:'premium.monthly',
    type:Type.AUTO_RENEWABLE_SUBSCRIPTION,originalTransactionId:'10000001',transactionId:'10000002',
    appAccountToken:user.id,signedDate:time-1000,expiresDate:time+3600000};
  const saved=[], notifications=new Set();
  let status=Status.ACTIVE, fail=false, apiCalls=0, renewal={originalTransactionId:tx.originalTransactionId,environment:'Sandbox',signedDate:time,gracePeriodExpiresDate:time+7200000};
  const notification={notificationUUID:'33333333-3333-4333-8333-333333333333',notificationType:'DID_RENEW',data:{signedTransactionInfo:'t.x.s'}};
  const verifier={
    verifyAndDecodeTransaction:async signed=>{if(signed!=='t.x.s')throw new Error('bad signature');return {...tx};},
    verifyAndDecodeNotification:async signed=>{if(signed!=='n.x.s')throw new Error('bad signature');return notification;},
    verifyAndDecodeRenewalInfo:async()=>renewal
  };
  const connection={verifier,client:{getAllSubscriptionStatuses:async()=>{
    apiCalls++;if(fail)throw new Error('network');
    return {bundleId:tx.bundleId,environment:'Sandbox',appAppleId:123456789,data:[{lastTransactions:[{
      originalTransactionId:tx.originalTransactionId,status,signedTransactionInfo:'t.x.s',signedRenewalInfo:'r.x.s'
    }]}]};
  }}};
  const repository={configured:true,list:async id=>saved.filter(r=>r.user===id),
    seen:async id=>notifications.has(id),record:async(id,record,n)=>{
      if(record)saved.push({user:id,...record});if(n)notifications.add(n);
    }};
  const billing=createAppleBilling({now:()=>time,repository,configuration:{bundleID:tx.bundleId,appAppleID:123456789,
    products:new Set(['premium.monthly','premium.yearly']),connections:new Map([[Environment.SANDBOX,connection]])}});
  return {billing,tx,saved,notification,connection,setStatus:s=>status=s,setFail:v=>fail=v,setRenewal:v=>renewal=v,get calls(){return apiCalls;}};
}
test('Unconfigured billing is inactive and cannot accept a receipt',async()=>{
  const billing=createAppleBilling();assert.equal((await billing.status(user)).configured,false);
  await assert.rejects(billing.verify(user,'t.x.s'),e=>e instanceof BillingError&&e.status===503);
  assert.equal(appleBillingConfiguration({}),null);
});
test('Official Apple verifier loads bundled roots and rejects unsigned/forged JWS without an API call',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'nutritrack-apple-test-'));
  try {
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const keyPath=join(folder,'test-only.p8');writeFileSync(keyPath,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const env={APPSTORE_BUNDLE_ID:'com.example.NutriTrackAI',APPSTORE_APP_APPLE_ID:'123456789',APPSTORE_ISSUER_ID:user.id,
      APPSTORE_KEY_ID:'TESTKEY001',APPSTORE_PRIVATE_KEY_PATH:keyPath,APPSTORE_PRODUCT_IDS:'premium.monthly',APPSTORE_ENVIRONMENTS:'Production,Sandbox',
      APPSTORE_ROOT_CA_PATHS:['AppleIncRootCertificate.cer','AppleRootCA-G2.cer','AppleRootCA-G3.cer'].map(name=>fileURLToPath(new URL('./certificates/'+name,import.meta.url))).join(',')};
    const configuration=appleBillingConfiguration(env);assert.equal(configuration.connections.size,2);
    let calls=0;const billing=createAppleBilling({configuration,repository:{configured:true,list:async()=>[],record:async()=>{calls++;}}});
    const forged=Buffer.from(JSON.stringify({alg:'ES256',x5c:[]})).toString('base64url')+'.'+Buffer.from('{}').toString('base64url')+'.'+Buffer.alloc(64).toString('base64url');
    await assert.rejects(billing.verify(user,forged),e=>e.code==='invalid_purchase');assert.equal(calls,0);
    assert.throws(()=>appleBillingConfiguration({...env,APPSTORE_ENVIRONMENTS:'Xcode'}));
  } finally {rmSync(folder,{recursive:true,force:true});}
});
test('Verified receipt is bound to account and grants only current server-confirmed status',async()=>{
  const f=fixture();const value=await f.billing.verify(user,'t.x.s');
  assert.equal(value.active,true);assert.equal(value.product_id,'premium.monthly');assert.equal(f.saved[0].user,user.id);
  assert.equal(f.calls,1);
  f.setStatus(Status.REVOKED);
  assert.equal((await f.billing.status(user)).active,false);assert.equal(f.calls,2);
});
test('Old signed receipt cannot revive a refunded or expired subscription',async()=>{
  const f=fixture();f.tx.signedDate=time-86400000;f.setStatus(Status.REVOKED);
  assert.equal((await f.billing.verify(user,'t.x.s')).active,false);
  f.setStatus(Status.ACTIVE);f.tx.expiresDate=time-1;
  assert.equal((await f.billing.verify(user,'t.x.s')).active,false);
});
test('Binding rejects another account, unknown product, wrong app or environment, forged JWS',async()=>{
  for(const edit of [
    tx=>tx.appAccountToken=other,tx=>tx.productId='free.hack',tx=>tx.bundleId='com.attacker',
    tx=>tx.environment='Production',tx=>delete tx.appAccountToken,tx=>tx.signedDate=time+120000
  ]){
    const f=fixture();edit(f.tx);await assert.rejects(f.billing.verify(user,'t.x.s'));assert.equal(f.saved.length,0);
  }
  await assert.rejects(fixture().billing.verify(user,'forged'));
  await assert.rejects(fixture().billing.verify(user,'f.a.k'));
});
test('Grace period requires verified matching renewal and its own future deadline',async()=>{
  const f=fixture();f.setStatus(Status.BILLING_GRACE_PERIOD);f.tx.expiresDate=time-1;
  assert.equal((await f.billing.verify(user,'t.x.s')).active,true);
  f.setRenewal({originalTransactionId:'wrong',environment:'Sandbox',signedDate:time,gracePeriodExpiresDate:time+1000});
  await assert.rejects(f.billing.verify(user,'t.x.s'));
});
test('Revocation and upgrades deny access even when original date remains future',async()=>{
  for(const edit of [tx=>tx.revocationDate=time-1,tx=>tx.isUpgraded=true]){
    const f=fixture();edit(f.tx);assert.equal((await f.billing.verify(user,'t.x.s')).active,false);
  }
});
test('Notifications are verified, idempotent and cannot trust a client premium flag',async()=>{
  const f=fixture();assert.equal((await f.billing.notification('n.x.s')).received,true);
  const calls=f.calls;assert.equal((await f.billing.notification('n.x.s')).duplicate,true);assert.equal(f.calls,calls);
  await assert.rejects(f.billing.notification('a.b.c'));
  f.notification.notificationUUID='44444444-4444-4444-8444-444444444444';
  f.setStatus(Status.EXPIRED);await f.billing.notification('n.x.s');
  assert.equal(f.saved.at(-1).active,false);
});
test('Apple status failure never falls back to a cached entitlement',async()=>{
  const f=fixture();await f.billing.verify(user,'t.x.s');f.setFail(true);
  await assert.rejects(f.billing.status(user));
});
const estimate={is_food:true,summary:'Plato',calories:520,protein:35,carbs:59,fat:16,confidence:'medium',notes:'Revisar'};
const request=()=>new Request('https://api.test/v1/food/analyze',{method:'POST',headers:{
 'Content-Type':'application/json','Idempotency-Key':'unique-request-key-001'
},body:JSON.stringify({image_base64:Buffer.from([255,216,255,224,255,217]).toString('base64'),mime_type:'image/jpeg',prompt_version:'food-v1'})});
test('AI fails closed before quotas and provider without active billing',async()=>{
  for(const check of [undefined,async()=>({configured:true,active:false}),async()=>{throw new Error('Apple down');}]){
    let paid=0,reserved=0;
    const h=createAPIHandler({apiKey:'test',authenticate:async()=>user,checkEntitlement:check,
      quota:{reserve:async()=>{reserved++;return {allowed:true};}},fetchImpl:async()=>{paid++;return new Response('{}');}});
    assert.ok(!(await h(request())).ok);assert.equal(paid,0);assert.equal(reserved,0);
  }
});
test('Refunded user cannot reuse a cached AI response or idempotency key',async()=>{
  let active=true,paid=0;
  const h=createAPIHandler({apiKey:'test',authenticate:async()=>user,checkEntitlement:async()=>({configured:true,active}),
    fetchImpl:async()=>{paid++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(estimate)}]}]}));}});
  assert.equal((await h(request())).status,200);active=false;
  assert.equal((await h(request())).status,402);assert.equal(paid,1);
});

