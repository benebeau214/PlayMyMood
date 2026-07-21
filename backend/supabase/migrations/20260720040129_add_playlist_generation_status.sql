-- 플리는 "버튼 누른 시점"에 status='generating'으로 먼저 생성되고,
-- 제목/소개는 생성 완료 후 편집 화면에서 입력하므로 title을 nullable로 완화한다.
-- "완전히 끝난 플리" = status='ready' AND title IS NOT NULL.
alter table playlists alter column title drop not null;

alter table playlists
  add column status text not null default 'generating'
    check (status in ('generating', 'ready', 'failed')),
  add column generated_at timestamptz;

-- playlists 행 변경을 소유 클라이언트에 실시간 푸시 (RLS 그대로 적용됨).
alter publication supabase_realtime add table playlists;
