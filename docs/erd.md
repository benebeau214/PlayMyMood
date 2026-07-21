# Play My Mood — Supabase ERD (v6 draft)

Figma 플로우(온보딩 → 기록하기 → 아카이빙 → 플레이리스트 재생)와 실제 화면 설명을 반영해
갱신했습니다. `agent/mood_intake_agent.py`, `agent/mood_music_agent.py`,
`agent/emoji_sticker_agent.py`의 입출력 스키마도 함께 참고했습니다.
(v6: 앨범 커버가 AI 생성 이미지 → **로그별 이모지 스티커** 조합 방식으로 변경 —
아래 "v5 → v6 변경점" 참고.)

## Mermaid

```mermaid
erDiagram
  PROFILES ||--o| USER_PREFERENCES : has
  COVER_STYLES ||--o{ USER_PREFERENCES : "chosen by"
  PROFILES ||--o{ DAILY_LOGS : writes
  DAILY_LOGS ||--o| TRACKS : "maps to"
  PROFILES ||--o{ PLAYLISTS : owns

  PROFILES {
    uuid id PK "= auth.users.id"
    text spotify_id UK
    text display_name
    timestamptz onboarding_completed_at
    timestamptz created_at
  }
  USER_PREFERENCES {
    uuid user_id PK_FK
    text era "2020s/2010s/2000s/pre_2000s"
    genre_enum_array genres "kpop/pop/edm/rock/jazz/trot/rnb/ballad/hiphop 다중"
    numeric fame_preference "0.00~1.00, 인기곡~숨은명곡"
    smallint cover_style_id FK
    timestamptz updated_at
  }
  COVER_STYLES {
    smallint id PK
    text code UK
    text label
    text sample_image_url
  }
  DAILY_LOGS {
    uuid id PK
    uuid user_id FK
    date log_date "logged_at에서 자동 계산 (generated)"
    text photo_path "Storage object path, 트랙 썸네일로도 재사용"
    text caption
    emotion_enum_array emotions "행복한/신나는/…/괴로운(23개) 중 최대 9개, 선택 순서 보존"
    jsonb emotion_scores "agent 산출 10축 점수"
    text mood_label
    text situation
    text image_context
    text sticker_path "로그별 이모지 스티커 PNG (Storage), nullable"
    jsonb sticker "스티커 agent 브리프 (심볼/감정/색상 등), nullable"
    timestamptz logged_at "실제 촬영 시각"
  }
  TRACKS {
    uuid id PK
    uuid log_id FK_UK "1 log = 1 song"
    text recco_track_id
    text title
    text_array artists
    text spotify_url
    int duration_ms
    smallint popularity
    jsonb audio_features
    text fit_reason
    timestamptz created_at
  }
  PLAYLISTS {
    uuid id PK
    uuid user_id FK
    date playlist_date
    text title "생성 완료 후 편집 화면에서 입력 (nullable)"
    text description
    text status "generating/ready/failed"
    timestamptz generated_at "생성 완료 시각"
    timestamptz created_at
  }
```

> `PLAYLISTS`와 `TRACKS`는 저장된 FK/조인 테이블 없이 **날짜로 유도되는 관계**입니다.
> `tracks.log_id → daily_logs.user_id, daily_logs.log_date` 가 `playlists.user_id,
> playlists.playlist_date`와 일치하는 트랙들이 곧 그 플리의 트랙입니다. 자세한 이유는
> 아래 "v3 → v4 변경점" 참고.

## 테이블 명세

### profiles
`auth.users`를 1:1로 확장하는 프로필 테이블.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| id | uuid | PK, FK → auth.users.id | Supabase Auth 유저 id 그대로 사용 |
| spotify_id | text | UNIQUE, NOT NULL | Spotify 계정 식별자 |
| display_name | text | | Spotify 표시 이름 |
| onboarding_completed_at | timestamptz | NULL 허용 | 온보딩 완료 시각, NULL이면 미완료 |
| created_at | timestamptz | NOT NULL, default now() | 가입 시각 |

### user_preferences
온보딩에서 받는 값 전부(장르 포함), 유저당 1행.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| user_id | uuid | PK, FK → profiles.id | |
| era | text | NOT NULL, CHECK IN ('2020s','2010s','2000s','pre_2000s') | 어느 시절 음악 취향인지 |
| genres | genre_enum[] | NOT NULL default '{}' | 좋아하는 장르 다중 선택 (kpop/pop/edm/rock/jazz/trot/rnb/ballad/hiphop) |
| fame_preference | numeric(3,2) | NOT NULL, CHECK 0.00~1.00 | 0=인기곡, 1=숨은명곡 (드래그 슬라이더 값) |
| cover_style_id | smallint | FK → cover_styles.id | 선호 앨범 커버 스타일 |
| updated_at | timestamptz | NOT NULL, default now() | |

`genre_enum`은 Postgres enum 타입: `CREATE TYPE genre_enum AS ENUM ('kpop','pop','edm','rock','jazz','trot','rnb','ballad','hiphop');`

### cover_styles (룩업)
`sample_image_url` 같은 추가 메타데이터가 있어서 enum이 아니라 테이블로 유지.
`code`는 화면 문구(`label`)와 분리된 고정 식별자로, 프론트/스토리지 경로 등에서
안정적으로 참조하기 위해 유지합니다(`label` 문구가 바뀌어도 `code`는 그대로).

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| id | smallserial | PK | |
| code | text | UNIQUE, NOT NULL | 고정 식별자 (예: `pastel`, `vintage`) |
| label | text | NOT NULL | 온보딩 화면 4개 보기 카드에 표시되는 문구 |
| sample_image_url | text | | 선택 카드에 보여줄 샘플 이미지 |

### daily_logs
기록하기 화면에서 생성되는 로그 1건.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| id | uuid | PK, default gen_random_uuid() | |
| user_id | uuid | FK → profiles.id, NOT NULL | |
| logged_at | timestamptz | NOT NULL, default now() | 실제 촬영/기록 시각 (시분초 포함) |
| log_date | date | GENERATED ALWAYS AS ((logged_at AT TIME ZONE 'Asia/Seoul')::date) STORED | 아카이빙/플리 그룹핑용 KST 날짜 버킷, 앱이 직접 넣지 않고 DB가 자동 계산 |
| photo_path | text | NOT NULL | Storage object path, 트랙 썸네일로도 재사용 |
| caption | text | | |
| emotions | emotion_enum[] | NOT NULL, CHECK array_length(emotions,1) BETWEEN 1 AND 9 | 사용자가 고른 감정 라벨 다중 선택, 배열 순서 = 선택 순서 |
| emotion_scores | jsonb | | agent가 산출한 10축 감정 점수 벡터 |
| mood_label | text | | agent 산출 요약 라벨 |
| situation | text | | agent 산출 상황 문장 (music agent 입력) |
| image_context | text | | agent 산출 이미지 분석 요약 |
| sticker_path | text | nullable | `emoji_sticker_agent.py`가 로그마다 생성하는 이모지 스티커 PNG의 Storage object path. Replicate 생성 URL은 만료되므로 우리 버킷(`<user_id>/stickers/<log_id>.png`)에 다운로드해 저장. 생성 전에는 NULL |
| sticker | jsonb | nullable | 스티커 agent 브리프 (`symbol`, `emotion_label`, `emotion_intensity`, `primary_color`/`secondary_color`/`highlight_color`/`shadow_color`, `color_rationale` 등). 앱이 커버 배치/배경색·라벨에 쓰거나 재생성 시 참고 |

`emotion_enum`은 `CUSTOM_EMOTION_LABELS` 23개를 그대로 순서대로 시드하는 Postgres enum:
`CREATE TYPE emotion_enum AS ENUM ('행복한','신나는','설레는','기쁜','뿌듯한','감동한','편안한','후련한','만족한','짜릿한','안도감','그리운','아련한','뭉클한','우울한','외로운','속상한','허무한','피곤한','짜증난','화난','불안한','괴로운');`
(`agent/mood_intake_agent.py`의 `CUSTOM_EMOTION_LABELS`와 정확히 일치하는 23개. Figma 목업엔 '멘붕'도 있었지만 지금은 빼고 시작 — 나중에 필요해지면 enum과 agent 코드를 같이 업데이트합니다.)
(enum 값은 생성 순서가 곧 정렬 순서라 `sort_order` 컬럼 없이 `ORDER BY`가 됩니다.)

**선택 순서는 배열 순서로 그대로 보존됩니다.** Postgres 배열은 원소 순서를 유지하므로
앱이 사용자가 고른 순서대로 `['설레는','기쁜','뿌듯한']`처럼 넣으면 조회 시에도 같은
순서로 반환됩니다. 별도의 `position` 컬럼이나 조인 테이블 없이 배열 인덱스 자체가
선택 순서를 표현하므로, 오선지 UI를 다시 그릴 때 `emotions[1]`, `emotions[2]`… 순서로
그대로 매핑하면 됩니다.

### tracks
`mood_music_agent.py` 추천 결과, 로그와 1:1.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| id | uuid | PK, default gen_random_uuid() | |
| log_id | uuid | UNIQUE, FK → daily_logs.id, NOT NULL | 1 log = 1 song |
| recco_track_id | text | | ReccoBeats 트랙 id |
| title | text | | |
| artists | text[] | | |
| spotify_url | text | | |
| duration_ms | integer | | |
| popularity | smallint | | |
| audio_features | jsonb | | valence/danceability/energy/tempo/popularity |
| fit_reason | text | | agent가 설명하는 추천 이유 |
| created_at | timestamptz | NOT NULL, default now() | |

플리 안에서의 트랙 순서는 별도로 저장하지 않고, 조회 시
`daily_logs.logged_at ASC`(그날 로그를 기록한 순서)로 정렬합니다.

### playlists
아카이빙 단위, 유저당 하루 1개. 이 안에 포함되는 트랙은 저장된 관계가 아니라
`tracks.log_id → daily_logs`를 거쳐 `user_id`와 `log_date = playlist_date`가
일치하는 트랙들을 조회 시점에 모으는 방식입니다(아래 "v3 → v4 변경점" 참고).
**앨범 커버도 저장하지 않습니다** — 그날 로그들의 `sticker_path` 스티커를 앱이 커버
레이아웃으로 배치해 렌더하므로 별도의 커버 이미지 컬럼이 없습니다(v6).

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| id | uuid | PK, default gen_random_uuid() | |
| user_id | uuid | FK → profiles.id, NOT NULL | |
| playlist_date | date | NOT NULL | |
| title | text | nullable | 생성 완료 후 편집 화면에서 입력 (버튼 누른 시점엔 아직 없음) |
| description | text | | 한 줄 소개글 |
| status | text | NOT NULL, default 'generating', CHECK IN ('generating','ready','failed') | 생성 상태 |
| generated_at | timestamptz | | 트랙 생성 완료 시각 |
| created_at | timestamptz | NOT NULL, default now() | 행 최초 생성(버튼 누른) 시각 |
| | | UNIQUE(user_id, playlist_date) | 유저당 하루 1개 플리 |

**생성 플로우 (v5)**: "플리 만들기" 버튼(20시 이후) → 그 즉시 `status='generating'`으로
행을 먼저 INSERT하고 id를 프론트에 반환 → 프론트는 그 행을 **Supabase Realtime으로
구독**하며 로딩 화면 표시 → 백엔드가 트랙을 만들고 `status='ready'`,
`generated_at=now()`로 UPDATE → Realtime이 완료를 밀어주면 프론트가 제목/소개 입력
화면으로 전환 → 사용자가 `title`/`description`을 UPDATE. "완전히 끝난 플리"는
`status='ready' AND title IS NOT NULL`. 실패 시 `status='failed'`로 두고 같은 행을
재시도(다시 `generating`으로) — `UNIQUE(user_id, playlist_date)`가 중복 행을 막아준다.
Realtime은 `playlists` 테이블을 `supabase_realtime` 퍼블리케이션에 추가해 활성화했고,
RLS(`auth.uid() = user_id`)가 그대로 적용돼 본인 플리 변경만 수신한다.

## v5 → v6 변경점 (앨범 커버 = 이모지 스티커)

앨범 커버를 "AI가 텍스트 프롬프트로 생성한 하루 대표 이미지 1장"에서 "로그별 이모지
스티커 조합"으로 바꾼 변경입니다. 새 `agent/emoji_sticker_agent.py` 기준.

- **스티커는 로그당 1개**: `emoji_sticker_agent.py`가 로그(캡션+감정)마다 스티커 컨셉을
  Claude로 정하고 Replicate(nano-banana)로 **PNG를 생성**합니다. 그래서 유니코드
  이모지가 아니라 앱 전용 스티커 **이미지**예요. → `daily_logs`에 `sticker_path`(이미지
  Storage 경로) + `sticker`(jsonb 메타) 추가.
- **`daily_logs.cover_prompt` 제거**: 하루 커버용 영문 프롬프트가 더 이상 필요 없습니다.
- **`playlists.cover_image_path` 제거**: 하루 커버를 서버에서 합성 이미지로 만들지 않고,
  앱이 그날 로그 스티커들을 커버 레이아웃으로 배치해 렌더합니다("이모지 데이터 저장 +
  앱에서 렌더"). 커버 이미지를 저장할 컬럼이 없습니다.
- **스티커 생성 시점은 서비스 로직 결정**: 로그 저장 시 즉시 생성할지, 플리 생성(20시)
  때 그날 로그들을 배치로 생성할지는 앱/서버 로직 선택입니다. 스키마는 `sticker_path`를
  nullable로 둬서 "아직 생성 안 됨"을 표현합니다(스키마 변경 불필요).
- **참고**: 스티커 생성은 Replicate 이미지 모델 호출이라 `REPLICATE_API_TOKEN`이
  필요하고(기존 `.env`의 `ANTHROPIC_API_KEY`와 함께), 비용/지연이 있으므로 실제 생성은
  Edge Function/백엔드 잡에서 돌리는 걸 권장합니다.

## v3 → v4 변경점

- **`profiles.avatar_url` 제거**: 현재 프론트 어디에서도 안 쓰여서 뺐습니다. 필요해지면
  Supabase Auth의 identity 메타데이터(`auth.users.raw_user_meta_data`)에서 가져올 수
  있어 굳이 복제해 저장할 이유가 없습니다.
- **`log_date`를 generated 컬럼으로 변경**: 원래도 시간 정보는 `logged_at`에 있었고
  `log_date`는 "하루 버킷"용 파생 값이었는데, 앱이 두 컬럼을 따로 채우다 보면
  시간대 계산 실수로 둘이 어긋날 수 있었습니다. `log_date`를
  `(logged_at AT TIME ZONE 'Asia/Seoul')::date`로 자동 계산되게 해서 항상 일치를
  보장합니다.
- **`playlist_tracks` 테이블 제거**: 트랙 편집(개별 제거/순서변경) 기능이 당분간 없기로
  확정돼서, "플리 = 그날 로그들의 트랙 전부"라는 관계를 조인 테이블 없이 날짜 매칭으로
  유도하기로 했습니다. 트랙 순서도 `daily_logs.logged_at`으로 대신합니다. 나중에 플리
  편집(트랙 제외/재정렬) 기능이 생기면 그때 `playlist_tracks(playlist_id, track_id,
  position)` 조인 테이블을 다시 추가하면 됩니다 — 지금 미리 만들어두지 않아도 마이그레이션
  부담은 크지 않습니다.
- **`cover_styles.code` 유지**: `label` 문구(마케팅/번역으로 바뀔 수 있는 텍스트)와
  분리된 안정적 식별자가 필요하다고 판단해 유지하기로 했습니다.

## 기존 설계 메모 (계속 유효)

- **인증**: Supabase Auth가 Spotify OAuth를 기본 제공하므로 `auth.users`는 그대로
  사용하고, `profiles`는 `auth.users.id`를 PK/FK로 1:1 확장하는 테이블로만 둡니다.
  Spotify access/refresh token은 Supabase Auth의 identity 데이터에 있으므로
  별도 저장하지 않습니다.
- **기록하기 → 트랙 매핑**: 로그 1개당 곡 1개(`"mapping": "one_log_to_one_song"`)이므로
  `tracks.log_id`를 `UNIQUE FK`로 걸어 1:1 관계로 모델링했습니다.
- **트랙 썸네일 = 로그 사진**: 트랙 개별 커버 이미지를 따로 생성/저장하지 않고
  `tracks.log_id → daily_logs.photo_path` 조인으로 UI를 채웁니다.
- **감정 점수 / 오디오 피처**: agent가 반환하는 다축 점수 벡터는 항상 같이 쓰이고
  개별 컬럼으로 쪼갤 실익이 적어 `jsonb`로 저장했습니다.
- **하루 앨범 커버 (v6)**: 아카이브/플레이리스트 화면 맨 위 큰 정사각형 커버는 그날의
  로그별 이모지 스티커(`daily_logs.sticker_path`)를 앱이 커버 레이아웃으로 배치해
  그립니다. 하나의 합성 커버 이미지를 서버에서 미리 만들지 않으므로 `playlists`에는
  커버 컬럼이 없습니다.
- **플레이리스트**: 유저당 하루 1개 플레이리스트를 전제로 `playlists`에
  `UNIQUE(user_id, playlist_date)`를 걸었습니다. "플리 만들기" 버튼이 20시 이후에만
  노출되는 규칙은 순수 앱/서버 로직이라 스키마에는 반영하지 않았습니다.
- **아카이빙 계층**: 연도 → 월(책장) → 일(앨범)은 전부 `playlists.playlist_date`에서
  파생되므로 별도 "연도/월" 테이블 없이 날짜 함수로 조회합니다. 책장의 LP 개수는
  해당 월의 `playlists` 행 수입니다(로그 수가 아님).
- **Storage**: 단일 비공개 버킷 `playmymood`에 유저 폴더로 구분해 저장합니다 —
  사진 `<user_id>/logs/...`(`daily_logs.photo_path`), 이모지 스티커
  `<user_id>/stickers/...`(`daily_logs.sticker_path`). 컬럼에는 URL이 아니라 object
  path만 저장하고, 서명 URL은 조회 시 생성합니다. (하루 커버는 저장하지 않고 스티커를
  앱에서 배치하므로 `covers/` 폴더는 더 이상 쓰지 않습니다.)
- **RLS**: 모든 유저 소유 테이블(`user_preferences`, `daily_logs`, `tracks`,
  `playlists`)은 `auth.uid() = user_id` (또는 상위 테이블 join) 기준 RLS를 걸어야
  합니다. 이번 ERD 단계에서는 정책까지는 작성하지 않았습니다.

## 남은 확인 사항

- **플리 만들기 8시 규칙**: 하루에 로그가 하나도 없으면 버튼 자체를 숨기는지,
  아니면 눌러도 빈 플리로 안내하는지 — 이건 스키마보다 프론트/서버 로직 확인
  차원이라 SQL 작성 전에 답이 없어도 진행 가능합니다.

## 다음 단계 (확인 후 진행)

1. 이 구조로 괜찮으면 실제 Supabase 마이그레이션 SQL(`supabase/migrations/*.sql`)로
   변환 — 테이블, enum 타입, check 제약, 인덱스, RLS 정책까지 포함.
2. `cover_styles` 룩업 테이블 시드 데이터 스크립트 작성.
3. `daily_logs` → `tracks` 추천, 로그별 `sticker_path` 스티커 생성(Replicate) 등
   생성 잡을 돌리는 Edge Function/백엔드 설계는 별도 논의.
