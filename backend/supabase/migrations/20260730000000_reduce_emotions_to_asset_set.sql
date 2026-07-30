-- Keep the database emotion enum aligned with the 19 emotion assets used by
-- the frontend and mood intake agent.
--
-- The four labels below were never exposed by the production picker. If a
-- legacy row contains one, preserve the record by mapping it to the closest
-- supported emotion instead of dropping the value.

alter type emotion_enum rename to emotion_enum_legacy;

create type emotion_enum as enum (
  '행복한','신나는','설레는','기쁜','뿌듯한','감동한','편안한','후련한','만족한',
  '짜릿한','뭉클한','우울한','속상한','허무한','피곤한','짜증난','화난','불안한',
  '괴로운'
);

alter table daily_logs
  alter column emotions type emotion_enum[]
  using (
    array_replace(
      array_replace(
        array_replace(
          array_replace(emotions::text[], '안도감', '후련한'),
          '그리운', '뭉클한'
        ),
        '아련한', '뭉클한'
      ),
      '외로운', '우울한'
    )::emotion_enum[]
  );

drop type emotion_enum_legacy;
