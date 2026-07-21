-- Spotify 로그인(=Supabase Auth signup)이 일어나면 profiles 행을 자동 생성한다.
-- auth.users에 새 유저가 insert될 때 트리거로 실행.
--
-- 필드 매핑(Supabase Spotify 프로바이더 기준, 첫 로그인 후 실제 값 확인 필요):
--   spotify_id   = raw_user_meta_data.provider_id (없으면 sub)  -- Spotify user id
--   display_name = raw_user_meta_data.name (없으면 full_name)   -- Spotify display name
--
-- SECURITY DEFINER + search_path='' 로 두어 RLS를 우회해 삽입하고,
-- 모든 객체를 스키마까지 fully-qualify 한다(Supabase 표준 handle_new_user 패턴).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, spotify_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'provider_id', ''),
      nullif(new.raw_user_meta_data ->> 'sub', ''),
      new.id::text  -- 최후 방어: 메타데이터에 id가 없어도 NOT NULL/로그인 실패를 막음
    ),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
