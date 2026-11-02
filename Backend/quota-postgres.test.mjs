import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
const exec=promisify(execFile);
const connection=process.env.NUTRITRACK_TEST_DATABASE_URL;

test('PostgreSQL: concurrent reservations, persistent idempotency, RLS permissions and deletion cascades',
  {skip:!connection,timeout:60000},async()=>{
    const url=new URL(connection);
    // Never run destructive test fixtures against a Supabase/production database.
    assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
    assert.equal(url.pathname,'/nutritrack_v57_test');
    const sql=async query=>(await exec('psql',[connection,'-X','-A','-t','-v','ON_ERROR_STOP=1','-c',query],{maxBuffer:2000000})).stdout.trim();
    await sql(`do $$begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
      end$$;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create schema storage; create table storage.objects(bucket_id text,name text,owner_id text);`);
    await sql(await readFile(new URL('./migrations/001_users_meals.sql',import.meta.url),'utf8'));
    await sql(await readFile(new URL('./migrations/002_account_quotas.sql',import.meta.url),'utf8'));
    const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
    await sql(`insert into auth.users values('${a}'),('${b}');`);
    const reserve=(user,key,fingerprint='payload')=>sql(`set role service_role; select public.nutritrack_reserve_ai('${user}',encode(sha256('${key}'::bytea),'hex'),encode(sha256('${fingerprint}'::bytea),'hex'));`)
      .then(v=>JSON.parse(v.split('\n').at(-1)));
    const requests=await Promise.all(Array.from({length:20},(_,i)=>reserve(a,'parallel-'+i)));
    assert.equal(requests.filter(r=>r.allowed).length,5);
    assert.equal(Number(await sql('select used from public.ai_global_usage')),5);
    assert.equal(Number(await sql(`select used from public.ai_user_usage where user_id='${a}'`)),5);
    const snapshot=JSON.parse(await sql(`select public.nutritrack_usage('${a}')`));
    assert.equal(snapshot.remaining,0);assert.ok(Date.parse(snapshot.resets_at)>Date.now());
    await sql('truncate public.ai_reservations, public.ai_user_usage, public.ai_global_usage; update public.ai_quota_settings set user_daily_limit=100,global_daily_limit=7;');
    const global=await Promise.all(Array.from({length:20},(_,i)=>reserve(i%2?a:b,'global-'+i)));
    assert.equal(global.filter(r=>r.allowed).length,7);
    assert.equal(Number(await sql('select used from public.ai_global_usage')),7);
    assert.equal(Number(await sql('select sum(used) from public.ai_user_usage')),7);
    await sql('truncate public.ai_reservations, public.ai_user_usage, public.ai_global_usage; update public.ai_quota_settings set user_daily_limit=5,global_daily_limit=200;');
    const same=await Promise.all(Array.from({length:10},()=>reserve(a,'same')));
    assert.equal(same.filter(r=>r.allowed).length,1);
    assert.equal(same.filter(r=>r.reason==='duplicate').length,9);
    const reservation=same.find(r=>r.allowed).reservation_id;
    await sql(`set role service_role;select public.nutritrack_finish_ai('${a}','${reservation}','{"summary":"cached"}'::jsonb);`);
    const replay=await reserve(a,'same');assert.equal(replay.state,'completed');assert.equal(replay.result.summary,'cached');
    assert.equal((await reserve(a,'same','different')).reason,'conflict');
    assert.equal(Number(await sql('select used from public.ai_global_usage')),1);
    for(const role of ['anon','authenticated']) {
      await assert.rejects(sql(`set role ${role};select public.nutritrack_reserve_ai('${a}',repeat('a',64),repeat('b',64));`),/permission denied/);
      await assert.rejects(sql(`set role ${role};select * from public.ai_quota_settings;`),/permission denied/);
      await assert.rejects(sql(`set role ${role};select public.nutritrack_owned_objects('${a}');`),/permission denied/);
    }
    await sql(`insert into public.profiles(user_id,name)values('${a}','Ana');
      insert into public.meals(id,user_id,recorded_at,title,meal_type,origin,calories,protein,carbs,fat)
      values(gen_random_uuid(),'${a}',now(),'Plato','comida','manual',500,30,50,15);
      insert into storage.objects values('photos','a.jpg','${a}'),('photos','b.jpg','${b}');`);
    assert.deepEqual(JSON.parse(await sql(`select public.nutritrack_owned_objects('${a}')`)),[{bucket:'photos',name:'a.jpg'}]);
    await sql(`delete from auth.users where id='${a}';`);
    for(const table of ['profiles','meals','ai_user_usage','ai_reservations']) {
      assert.equal(Number(await sql(`select count(*) from public.${table} where user_id='${a}'`)),0);
    }
    assert.equal(Number(await sql('select used from public.ai_global_usage')),1);
    await assert.rejects(reserve(a,'deleted'),/Unknown account/);
    await sql(`truncate public.ai_reservations,public.ai_user_usage,public.ai_global_usage;
      insert into public.ai_user_usage values('${b}',(now() at time zone 'America/Mazatlan')::date-1,5);`);
    assert.equal(JSON.parse(await sql(`select public.nutritrack_usage('${b}')`)).remaining,5);
    // v5.8: real database budgets and account-scoped recovery, no production access.
    await sql(await readFile(new URL('./migrations/003_ai_spend.sql',import.meta.url),'utf8'));
    await sql(await readFile(new URL('./migrations/004_cloud_sync.sql',import.meta.url),'utf8'));
    await sql(`create or replace function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      update public.ai_quota_settings set daily_budget_microusd=1000,monthly_budget_microusd=2000;`);
    const parent=await reserve(b,'spend-parent');
    const spend=()=>sql(`select public.nutritrack_reserve_spend('${b}','${parent.reservation_id}','gpt-4o-mini',1000,1000)`)
      .then(JSON.parse);
    const allocations=await Promise.all(Array.from({length:12},spend));
    assert.equal(allocations.filter(r=>r.allowed).length,1);
    assert.equal(allocations.filter(r=>r.reason==='budget_exhausted').length,11);
    assert.equal(Number(await sql("select charged_microusd from public.ai_spend_totals where period='day'")),750);
    const attempt=allocations.find(r=>r.allowed).spend_id;
    await sql(`select public.nutritrack_finish_spend('${b}','${attempt}',1000,100,500,'resp_test');`);
    assert.equal(Number(await sql("select charged_microusd from public.ai_spend_totals where period='day'")),173);
    // Settlement is idempotent, even if a caller repeats it.
    await sql(`select public.nutritrack_finish_spend('${b}','${attempt}',1000,100,500,'resp_test');`);
    assert.equal(Number(await sql("select charged_microusd from public.ai_spend_totals where period='month'")),173);
    assert.equal((await spend()).allowed,true);
    await sql('update public.ai_quota_settings set daily_budget_microusd=100000,monthly_budget_microusd=1000');
    assert.equal((await spend()).reason,'budget_exhausted');
    assert.equal(JSON.parse(await sql(`select public.nutritrack_reserve_spend('${b}','${parent.reservation_id}','unknown',100,100)`)).reason,'model_rate_missing');
    assert.equal(JSON.parse(await sql(`select public.nutritrack_reserve_spend('${b}','${parent.reservation_id}','gpt-4o-mini',40001,100)`)).reason,'token_limit');
    for(const role of ['anon','authenticated']) {
      await assert.rejects(sql(`set role ${role};select public.nutritrack_reserve_spend('${b}','${parent.reservation_id}','gpt-4o-mini',1,1)`),/permission denied/);
      await assert.rejects(sql(`set role ${role};select * from public.ai_spend_attempts`),/permission denied/);
    }
    const key='water:33333333-3333-4333-8333-333333333333';
    const sync=(user,items)=>sql(`set role authenticated;set request.jwt.claim.sub='${user}';select public.nutritrack_sync('${JSON.stringify(items)}'::jsonb)`)
      .then(v=>JSON.parse(v.split('\n').at(-1)));
    const change={key,base_version:0,deleted:false,payload:{id:key.slice(6),recordedAt:800000000,milliliters:250}};
    const inserts=await Promise.all([sync(b,[change]),sync(b,[change])]);
    assert.equal(inserts.filter(r=>!r.results[0].conflict).length,1);
    assert.equal(inserts.filter(r=>r.results[0].conflict).length,1);
    assert.equal((await sync(b,[{...change,base_version:1,deleted:true,payload:null}])).results[0].item.version,2);
    assert.equal((await sync(b,[change])).results[0].conflict,true);
    const extra1='water:44444444-4444-4444-8444-444444444444', extra2='water:55555555-5555-4555-8555-555555555555';
    await sync(b,[{...change,key:extra1,payload:{...change.payload,id:extra1.slice(6)}},{...change,key:extra2,payload:{...change.payload,id:extra2.slice(6)}}]);
    const pull=(after=0,until=null)=>sql(`set role authenticated;set request.jwt.claim.sub='${b}';select public.nutritrack_pull_sync(${after},${until===null?'null':until},1)`)
      .then(v=>JSON.parse(v.split('\n').at(-1)));
    const firstPage=await pull();assert.equal(firstPage.items[0].deleted,true);assert.equal(firstPage.has_more,true);
    await sync(b,[{...change,key:extra1,base_version:1,payload:{...change.payload,id:extra1.slice(6),milliliters:500}}]);
    const secondPage=await pull(firstPage.next_cursor,firstPage.until);
    assert.equal(secondPage.items[0].key,extra2);assert.equal(secondPage.has_more,false);
    const nextCycle=await pull(secondPage.next_cursor);
    assert.equal(nextCycle.items[0].key,extra1);assert.equal(nextCycle.items[0].payload.milliliters,500);
    const noChange=await pull(nextCycle.next_cursor);assert.deepEqual(noChange.items,[]);
    await sql(`insert into auth.users values('${a}')`);
    assert.equal(Number((await sql(`set role authenticated;set request.jwt.claim.sub='${a}';select count(*) from public.sync_records`)).split('\n').at(-1)),0);
    await assert.rejects(sql(`set role authenticated;insert into public.sync_records(user_id,key,payload)values('${b}','profile','{}')`),/permission denied/);
    // v5.9 exercises the real migrations, storage RLS and purchase binding.
    await sql(`create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      alter table storage.objects add column metadata jsonb default '{"size":1000}',add column created_at timestamptz default now();
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated;grant select,insert,delete on storage.objects to authenticated;`);
    await sql(await readFile(new URL('./migrations/006_apple_billing.sql',import.meta.url),'utf8'));
    const storageMigration=await readFile(new URL('./migrations/007_storage_sync.sql',import.meta.url),'utf8');
    await sql(storageMigration);await sql(storageMigration);
    const photo='profile/'+b+'/'+'f'.repeat(64)+'.jpg';
    await sql(`set role authenticated;set request.jwt.claim.sub='${b}';
      insert into storage.objects(bucket_id,name,owner_id)values('nutritrack-private','${b}/${photo}','${b}');`);
    await assert.rejects(sql(`set role authenticated;set request.jwt.claim.sub='${b}';
      insert into storage.objects(bucket_id,name,owner_id)values('nutritrack-private','${a}/${photo}','${a}');`),/row-level security/);
    const profile={id:b,name:'Usuario',weightKG:70,heightCM:170,age:30,goal:'maintain',activity:'light',reference:'female',createdAt:800000000,photoSchema:1,photoPath:photo};
    assert.equal((await sync(b,[{key:'profile',base_version:0,deleted:false,payload:profile}])).results[0].conflict,false);
    assert.equal((await sql(`set role authenticated;set request.jwt.claim.sub='${b}';select public.nutritrack_photo_can_delete('${photo}')`)).split('\n').at(-1),'f');
    await sql(`set role authenticated;set request.jwt.claim.sub='${b}';delete from storage.objects where name='${b}/${photo}';`);
    assert.equal(Number(await sql(`select count(*) from storage.objects where name='${b}/${photo}'`)),1);
    const oldClient={...profile,name:'Editado'};delete oldClient.photoSchema;delete oldClient.photoPath;
    await sync(b,[{key:'profile',base_version:1,deleted:false,payload:oldClient}]);
    assert.equal(await sql(`select payload->>'photoPath' from public.sync_records where user_id='${b}' and key='profile'`),photo);
    await sync(b,[{key:'preferences',base_version:0,deleted:false,payload:{id:b,settingsSchema:1,preferencesData:'e30='}}]);
    const page=async schema=>JSON.parse((await sql(`set role authenticated;set request.jwt.claim.sub='${b}';select public.nutritrack_pull_sync(0,null,50,${schema});`)).split('\n').at(-1));
    assert.equal((await page(1)).items.some(r=>r.key==='preferences'),false);
    assert.equal((await page(1)).items.find(r=>r.key==='profile').payload.photoPath,undefined);
    assert.equal((await page(2)).items.find(r=>r.key==='profile').payload.photoPath,photo);
    await sql(`set role service_role;select public.nutritrack_billing_record('${b}','100001','Sandbox','premium.monthly',now()+interval '1 day',1,'88888888-8888-4888-8888-888888888888');`);
    assert.equal(Number(await sql('select count(*) from public.apple_subscriptions')),1);
    await assert.rejects(sql(`set role authenticated;select public.nutritrack_billing_list('${b}');`),/permission denied/);
    await assert.rejects(sql(`set role service_role;select public.nutritrack_billing_record('${a}','100001','Sandbox','premium.monthly',now(),1,null);`),/another account/);
    assert.equal((await sql(`set role service_role;select public.nutritrack_billing_record('${b}','100001','Sandbox','premium.monthly',now(),2,'88888888-8888-4888-8888-888888888888');`)).split('\n').at(-1),'f');
    assert.equal(JSON.parse(await sql(`select public.nutritrack_owned_objects('${b}')`)).some(o=>o.name===b+'/'+photo),true);
    const charged=Number(await sql("select charged_microusd from public.ai_spend_totals where period='month'"));
    await sql(`delete from auth.users where id='${b}'`);
    assert.equal(Number(await sql('select count(*) from public.sync_records')),0);
    assert.equal(Number(await sql('select count(*) from public.apple_subscriptions')),0);
    assert.equal(Number(await sql('select count(*) from public.ai_spend_attempts where user_id is not null')),0);
    assert.equal(Number(await sql("select charged_microusd from public.ai_spend_totals where period='month'")),charged);
  });
