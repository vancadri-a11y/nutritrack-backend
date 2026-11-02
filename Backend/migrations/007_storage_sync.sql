begin;
-- Private objects retain the owner's UID as the first folder. Never make this
-- bucket public. Database backups do not back up the object bytes.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('nutritrack-private','nutritrack-private',false,2097152,array['image/jpeg'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

alter table public.sync_records drop constraint if exists sync_records_key_check;
alter table public.sync_records add constraint sync_records_key_check
 check(key in ('profile','preferences') or key ~ '^(meal|water|workout|log):[0-9a-fA-F-]{36}$');

create or replace function public.nutritrack_valid_photo_path(p_path text) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(p_path ~ '^(profile|meal)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.jpg$',false)
$$;

-- Run inside the existing per-user compare-and-swap transaction. Old 5.8
-- clients do not know the photo fields, so an ordinary text edit preserves them.
create or replace function public.nutritrack_check_photo_reference() returns trigger
language plpgsql security definer set search_path='' as $$
declare photo text; expected text;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,58));
 if new.deleted then return new; end if;
 if new.key='preferences' then
  if new.payload->>'settingsSchema'<>'1' or jsonb_typeof(new.payload->'preferencesData')<>'string'
     or length(new.payload->>'preferencesData')>80000 then raise exception 'Invalid preferences'; end if;
  return new;
 end if;
 if new.key<>'profile' and new.key not like 'meal:%' then return new; end if;
 if not(new.payload ? 'photoSchema') then
  if tg_op='UPDATE' and old.payload ? 'photoSchema' then
   new.payload := new.payload || jsonb_build_object('photoSchema',old.payload->'photoSchema','photoPath',old.payload->'photoPath');
  end if;
  return new;
 end if;
 if new.payload->>'photoSchema'<>'1' then raise exception 'Invalid photo schema'; end if;
 photo := new.payload->>'photoPath';
 if photo is null then return new; end if;
 expected := case when new.key='profile' then 'profile/' else 'meal/' end || lower(new.payload->>'id') || '/';
 if not public.nutritrack_valid_photo_path(photo) or left(photo,length(expected))<>expected then raise exception 'Invalid photo reference'; end if;
 if not exists(select 1 from storage.objects where bucket_id='nutritrack-private' and name=new.user_id::text||'/'||photo) then
  raise exception 'Upload photo before referencing it';
 end if;
 return new;
end $$;
drop trigger if exists nutritrack_photo_reference on public.sync_records;
create trigger nutritrack_photo_reference before insert or update on public.sync_records
 for each row execute function public.nutritrack_check_photo_reference();

create or replace function public.nutritrack_photo_can_delete(p_path text) returns boolean
language plpgsql security definer set search_path='' as $$
declare u uuid := auth.uid();
begin
 if u is null or not public.nutritrack_valid_photo_path(p_path) then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,58));
 return not exists(select 1 from public.sync_records where user_id=u and not deleted and payload->>'photoPath'=p_path);
end $$;
create or replace function public.nutritrack_photo_can_insert(p_name text) returns boolean
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); bytes bigint; objects bigint;
begin
 if u is null or left(p_name,37)<>u::text||'/' or not public.nutritrack_valid_photo_path(substring(p_name from 38)) then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,58));
 select coalesce(sum(coalesce((metadata->>'size')::bigint,2097152)),0),count(*) into bytes,objects
  from storage.objects where bucket_id='nutritrack-private' and left(name,37)=u::text||'/';
 -- Reserve the maximum possible object size, including concurrent uploads.
 return bytes+2097152<=536870912 and objects<5000;
end $$;
create or replace function public.nutritrack_unused_photos() returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); result jsonb;
begin
 if u is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,58));
 select coalesce(jsonb_agg(name),'[]'::jsonb) into result from (
  select o.name from storage.objects o where o.bucket_id='nutritrack-private' and left(o.name,37)=u::text||'/'
   and public.nutritrack_valid_photo_path(substring(o.name from 38)) and o.created_at<now()-interval '24 hours'
   and not exists(select 1 from public.sync_records r where r.user_id=u and not r.deleted and r.payload->>'photoPath'=substring(o.name from 38))
  order by o.created_at limit 100
 ) pending;
 return result;
end $$;
revoke all on function public.nutritrack_photo_can_delete(text), public.nutritrack_photo_can_insert(text),public.nutritrack_unused_photos() from public,anon;
grant execute on function public.nutritrack_photo_can_delete(text),public.nutritrack_photo_can_insert(text),public.nutritrack_unused_photos() to authenticated;
drop policy if exists nutritrack_private_read on storage.objects;
create policy nutritrack_private_read on storage.objects for select to authenticated
 using(bucket_id='nutritrack-private' and left(name,37)=(select auth.uid())::text||'/');
drop policy if exists nutritrack_private_insert on storage.objects;
create policy nutritrack_private_insert on storage.objects for insert to authenticated
 with check(bucket_id='nutritrack-private' and public.nutritrack_photo_can_insert(name));
-- Deliberately no UPDATE policy: content-addressed versions cannot be overwritten.
drop policy if exists nutritrack_private_delete on storage.objects;
create policy nutritrack_private_delete on storage.objects for delete to authenticated
 using(bucket_id='nutritrack-private' and left(name,37)=(select auth.uid())::text||'/'
  and public.nutritrack_photo_can_delete(substring(name from 38)));

-- Keep v5.8 consumers working: their pull omits the new settings record and photo
-- metadata. The server preserves the latter when those clients push edits.
drop function if exists public.nutritrack_pull_sync(bigint,bigint,integer);
create or replace function public.nutritrack_pull_sync(p_after bigint default 0,p_until bigint default null,p_limit integer default 50,p_schema integer default 1) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); head bigint; upper_bound bigint; items jsonb; next_cursor bigint; more boolean;
begin
 if u is null then raise exception 'Authentication required'; end if;
 if p_after<0 or p_limit<1 or p_limit>50 or p_schema not in(1,2) then raise exception 'Invalid cursor'; end if;
 select revision into head from public.sync_heads where user_id=u;
 head:=coalesce(head,0); upper_bound:=coalesce(p_until,head);
 if upper_bound>head or upper_bound<p_after then raise exception 'Invalid snapshot'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('key',r.key,'version',r.version,'deleted',r.deleted,
   'payload',case when p_schema=1 then r.payload-'photoSchema'-'photoPath' else r.payload end) order by r.revision),'[]'::jsonb),max(r.revision)
 into items,next_cursor from(select * from public.sync_records where user_id=u and revision>p_after and revision<=upper_bound
  and(p_schema=2 or key<>'preferences') order by revision limit p_limit) r;
 next_cursor:=coalesce(next_cursor,p_after);
 select exists(select 1 from public.sync_records where user_id=u and revision>next_cursor and revision<=upper_bound and(p_schema=2 or key<>'preferences')) into more;
 if not more then next_cursor:=upper_bound; end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor,'until',upper_bound,'has_more',more);
end $$;
revoke all on function public.nutritrack_pull_sync(bigint,bigint,integer,integer) from public,anon;
grant execute on function public.nutritrack_pull_sync(bigint,bigint,integer,integer) to authenticated;
-- Service-imported objects may lack owner_id; the private UID prefix still
-- belongs to that account and must be erased on account deletion.
create or replace function public.nutritrack_owned_objects(p_user_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'name',name)),'[]'::jsonb)
 from storage.objects where owner_id=p_user_id::text
 or (bucket_id='nutritrack-private' and left(name,37)=p_user_id::text||'/');
$$;
revoke all on function public.nutritrack_owned_objects(uuid) from public,anon,authenticated;
grant execute on function public.nutritrack_owned_objects(uuid) to service_role;
commit;
