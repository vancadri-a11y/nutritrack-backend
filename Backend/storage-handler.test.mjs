import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStorageHandler, validPhotoPath, jpegDimensions, MAX_PHOTO_BYTES } from './storage-handler.mjs';
import { validateSyncChanges } from './sync-validation.mjs';
const id='11111111-1111-4111-8111-111111111111',user={id,token:'test-user-jwt'};
// Minimal marker stream exercises bounds; production photos are re-encoded by iOS.
const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0x1f,0xff,0xd9]);
const digest=createHash('sha256').update(jpeg).digest('hex');
const path='meal/'+id+'/'+digest+'.jpg';
const req=(method,p=path,bytes=jpeg,type='image/jpeg')=>new Request('https://api.test/v1/storage/'+p,{
 method,headers:{'Content-Type':type},...(['PUT','POST'].includes(method)?{body:bytes}:{})
});
test('Photo paths reject traversal, uppercase or cross-kind paths and invalid UUIDs',()=>{
 assert.equal(validPhotoPath(path),true);
 for(const value of ['../'+path,path.replace('.jpg','.png'),'user/'+path,path.toUpperCase(),path.replace(id,'x'.repeat(36))]) assert.equal(validPhotoPath(value),false);
 assert.deepEqual(jpegDimensions(jpeg),{width:1,height:1});
 assert.equal(jpegDimensions(Buffer.from([255,216,255,217])),null);
});
test('Private storage always prefixes verified owner and forwards JWT, never admin',async()=>{
 const calls=[];const h=createStorageHandler({root:new URL('https://db.supabase.co'),publishableKey:'public',fetchImpl:async(url,opts)=>{
  calls.push({url,opts});return new Response(jpeg,{headers:{'Content-Type':'image/jpeg'}});
 }});
 assert.equal((await h(req('PUT'),user)).status,201);
 assert.equal(calls[0].url.pathname,'/storage/v1/object/nutritrack-private/'+id+'/'+path);
 assert.equal(calls[0].opts.headers.Authorization,'Bearer test-user-jwt');
 assert.equal(calls[0].opts.headers['x-upsert'],'false');
 assert.equal((await h(req('GET'),user)).status,200);
 assert.ok(calls[1].url.pathname.includes('/authenticated/'));
 assert.equal((await h(req('GET'),null)).status,401);
});
test('Invalid MIME, digest, size and malformed photo are rejected before storage',async()=>{
 let calls=0;const h=createStorageHandler({root:new URL('https://db.supabase.co'),publishableKey:'public',fetchImpl:async()=>{calls++;return new Response('{}');}});
 assert.equal((await h(req('PUT',path,jpeg,'image/png'),user)).status,415);
 assert.equal((await h(req('PUT',path,Buffer.from('not a jpeg')),user)).status,400);
 assert.equal((await h(req('PUT',path.replace(digest,'a'.repeat(64))),user)).status,400);
 assert.equal((await h(req('PUT',path,Buffer.alloc(MAX_PHOTO_BYTES+1)),user)).status,413);
 assert.equal(calls,0);
});
test('A referenced photo cannot be deleted and an inaccessible download exposes no bytes',async()=>{
 const h=createStorageHandler({root:new URL('https://db.supabase.co'),publishableKey:'public',fetchImpl:async url=>
  url.pathname.includes('/rpc/')?new Response('false'):new Response('{}',{status:404})});
 assert.equal((await h(req('DELETE'),user)).status,409);
 assert.equal((await h(req('GET'),user)).status,404);
});
test('Cleanup refuses another account path returned by an unexpected upstream',async()=>{
 let removals=0;
 const h=createStorageHandler({root:new URL('https://db.supabase.co'),publishableKey:'public',fetchImpl:async(url,opts)=>{
  if(url.pathname.includes('/rpc/'))return new Response(JSON.stringify(['22222222-2222-4222-8222-222222222222/'+path]));
  removals++;return new Response('{}');
 }});
 assert.equal((await h(req('POST','cleanup',Buffer.alloc(0)),user)).status,503);assert.equal(removals,0);
});
test('Photo references and settings are allowlisted while inline files and ownership injection are rejected',()=>{
 const item={key:'meal:'+id,base_version:0,deleted:false,payload:{id,title:'Plato',photoSchema:1,photoPath:path}};
 assert.doesNotThrow(()=>validateSyncChanges({items:[item]}));
 for(const p of [{...item.payload,imageData:'inline'},{...item.payload,photoPath:path.replace(id,'22222222-2222-4222-8222-222222222222')},{...item.payload,photoSchema:2}])
  assert.throws(()=>validateSyncChanges({items:[{...item,payload:p}]}));
 const settings={theme:'dark',accent:'forest',onlinePhotos:false,waterGoal:2000,favorites:['recipe'],symbols:{},workoutProgress:{day:[0,1]},reminderEnabled:false,reminderHours:[8,14,20,17]};
 const pref={key:'preferences',base_version:0,deleted:false,payload:{id,settingsSchema:1,preferencesData:Buffer.from(JSON.stringify(settings)).toString('base64')}};
 assert.doesNotThrow(()=>validateSyncChanges({items:[pref]}));
 settings.reminderHours=[99];
 pref.payload.preferencesData=Buffer.from(JSON.stringify(settings)).toString('base64');
 assert.throws(()=>validateSyncChanges({items:[pref]}));
});

