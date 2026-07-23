# service — PlayMyMood 에이전트 서비스

프론트가 로그를 저장한 뒤 호출하는 FastAPI 서비스. 기존 `agent/*.py`를 그대로 재사용해
`daily_logs`의 AI 생성 필드를 채운다:

- `mood_intake_agent` → `situation`, `image_context`, `emotion_scores`, `mood_label`
- `emoji_sticker_agent` → `sticker_path`(Storage), `sticker`(jsonb) — Replicate 토큰 있을 때만
- (`mood_music_agent` → `tracks` 는 아직 미연결, 다음 단계)

`agent/`는 수정하지 않고 import만 한다.

## 셋업

```bash
# 리포 루트에서 (agent 패키지를 import하려면 루트가 sys.path에 있어야 함)
cd /path/to/PlayMyMood

python -m venv .venv && source .venv/bin/activate   # (선택) 가상환경
pip install -r service/requirements.txt

cp service/.env.example service/.env
# service/.env 에 값 채우기:
#   SUPABASE_SERVICE_ROLE_KEY  (대시보드 → Project Settings → API → service_role, 비밀!)
#   ANTHROPIC_API_KEY
#   REPLICATE_API_TOKEN (스티커 생성용, 선택)
```

> `SUPABASE_SERVICE_ROLE_KEY`는 **비밀 키**다. 절대 프론트/깃에 넣지 말 것.
> `service/.env`는 루트 `.gitignore`의 `.env` 규칙으로 이미 제외됨.

## 실행

`main.py`가 `service/.env`를 자동으로 읽으므로 수동 로드는 필요 없다.
리포 **루트**에서 실행해야 `from agent...` import가 된다.

```bash
uvicorn service.main:app --reload --port 8000
```

- 헬스체크: `GET http://localhost:8000/health`
- 로그 처리: `POST http://localhost:8000/process-log`  body `{"log_id": "<uuid>"}`

프론트(`front/config.js`의 `AGENT_SERVICE_URL`)가 로그 저장 직후 이 엔드포인트를 호출한다.

## 흐름

1. 프론트: 사진 업로드 + `daily_logs` insert → 새 `log_id` 받음
2. 프론트: `POST /process-log {log_id}` 호출 (백그라운드)
3. 서비스: 로그 조회 → 사진 다운로드 → intake 분석 → (선택)스티커 생성/업로드 → `daily_logs` 업데이트
4. 프론트: 재조회 또는 Realtime으로 채워진 값 확인

## 주의

- Replicate 이미지 생성은 **비용·시간**이 든다. 토큰이 없으면 스티커는 건너뛰고 나머지만 채운다.
- 지금은 로그당 동기 처리다(요청이 분석/생성 끝날 때까지 대기). 나중에 큐/백그라운드로
  뺄 수 있음.
