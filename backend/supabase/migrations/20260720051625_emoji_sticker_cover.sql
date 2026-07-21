-- 앨범 커버가 AI 생성 이미지 → 로그별 이모지 스티커 조합으로 변경.
-- 스티커는 emoji_sticker_agent.py가 로그마다 생성하는 PNG(Storage) + 메타(jsonb).
-- 하루 커버는 서버에서 합성하지 않고 앱이 그날 스티커들을 배치해 렌더하므로
-- playlists.cover_image_path는 제거한다.

alter table daily_logs drop column cover_prompt;
alter table daily_logs add column sticker_path text;
alter table daily_logs add column sticker jsonb;

alter table playlists drop column cover_image_path;
