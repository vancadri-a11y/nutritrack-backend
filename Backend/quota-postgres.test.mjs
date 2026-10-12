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
    await sql(`create role anon; create role authenticated; create role service_role;
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
  });
