-- 온보딩에서 제거된 앨범 커버 스타일 취향 데이터도 스키마에서 정리한다.
alter table user_preferences
  drop column if exists cover_style_id;

drop table if exists cover_styles;
