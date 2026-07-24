"""PlayMyMood agent service.

로그 저장 후 프론트가 호출하는 FastAPI 서비스. 기존 agent/*.py를 그대로 재사용해서
daily_logs의 AI 생성 필드(situation, image_context, emotion_scores, mood_label,
sticker_path, sticker)를 채운다.

실행(리포 루트에서):
    uvicorn service.main:app --reload --port 8000
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel
from supabase import create_client

from agent.mood_intake_agent import EmotionLog, analyze_daily_logs
from agent.mood_music_agent import recommend_music

# 스티커 에이전트는 Replicate 토큰이 있을 때만 동작하므로 선택적으로 import.
try:
    from agent.emoji_sticker_agent import generate_log_stickers
except Exception:  # pragma: no cover
    generate_log_stickers = None


# service/.env 를 자동 로드. override=True 로 두어 시스템/셸에 미리 설정된
# 옛날 값(예: 예전 ANTHROPIC_API_KEY)이 있어도 .env 값이 항상 이기게 한다.
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

BUCKET = "playmymood"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
GENRE_LABELS = {
    "kpop": "K-pop",
    "pop": "Pop",
    "edm": "EDM",
    "rock": "Rock",
    "jazz": "Jazz",
    "trot": "Korean trot",
    "rnb": "R&B",
    "ballad": "Korean ballad",
    "hiphop": "Hip-hop",
}

# 어떤 키가 로드됐는지 확인용(끝 4자리만). 시작 로그에서 .env 키가 맞는지 대조.
_anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
print(
    "[service] ANTHROPIC_API_KEY:",
    ("..." + _anthropic_key[-4:]) if _anthropic_key else "(없음!)",
)

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

app = FastAPI(title="PlayMyMood Agent Service")

# 개발 편의를 위해 모든 오리진 허용. 배포 시 프론트 오리진으로 좁힐 것.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ProcessLogRequest(BaseModel):
    log_id: str


class GeneratePlaylistRequest(BaseModel):
    user_id: str
    date: str  # log_date, "YYYY-MM-DD"


def _load_music_preferences(user_id: str) -> dict[str, Any]:
    response = (
        supabase.table("user_preferences")
        .select("era, genres, fame_preference")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    row = response.data or {}
    genres = row.get("genres") if isinstance(row.get("genres"), list) else []
    preferences: dict[str, Any] = {
        "preferred_genres": [
            GENRE_LABELS[genre]
            for genre in genres
            if genre in GENRE_LABELS
        ],
    }
    era = str(row.get("era") or "").strip()
    if era:
        preferences["preferred_era"] = era
    fame_preference = row.get("fame_preference")
    if fame_preference is not None:
        try:
            # 온보딩 UI는 왼쪽(0)이 인기곡, 오른쪽(1)이 숨은 명곡이다.
            preferences["obscurity_preference"] = max(0.0, min(1.0, float(fame_preference)))
        except (TypeError, ValueError):
            pass
    return preferences


def _download_photo(photo_path: str) -> str | None:
    """Storage에서 사진을 임시 파일로 내려받아 로컬 경로를 반환."""
    if not photo_path:
        return None
    data = supabase.storage.from_(BUCKET).download(photo_path)
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
    handle.write(data)
    handle.close()
    return handle.name


def _run_intake(log: dict[str, Any], image_path: str | None) -> dict[str, Any]:
    """mood_intake_agent로 situation/image_context/emotion_scores/mood_label 산출."""
    emotions = tuple(dict.fromkeys(log.get("emotions") or []))
    emotion_log = EmotionLog(
        caption=log.get("caption") or "",
        emoji=emotions[0] if emotions else "",
        image_path=image_path,
        created_at=log.get("logged_at"),
        emojis=emotions,
    )
    analysis = analyze_daily_logs([emotion_log])
    result = analysis["log_results"][0]
    return {
        "situation": result["situation"],
        "image_context": result["image_context"],
        "emotion_scores": result["emotions"],
        "mood_label": result["mood_label"],
    }


def _run_sticker(log: dict[str, Any], emotion_scores: dict[str, Any]) -> dict[str, Any] | None:
    """emoji_sticker_agent로 스티커 PNG 생성 → Storage 업로드 → sticker_path/sticker 반환."""
    if generate_log_stickers is None or not os.environ.get("REPLICATE_API_TOKEN"):
        return None
    with tempfile.TemporaryDirectory() as output_dir:
        raw_log = {
            "id": str(log["id"]),
            "text": log.get("caption") or log.get("mood_label") or "오늘의 기록",
            "emotions": emotion_scores or {},
        }
        result = generate_log_stickers([raw_log], output_dir=output_dir)
        sticker = result["stickers"][0]
        local_path = sticker.get("local_path")
        if not local_path or not Path(local_path).is_file():
            return None
        storage_path = f"{log['user_id']}/stickers/{log['id']}.png"
        with open(local_path, "rb") as handle:
            supabase.storage.from_(BUCKET).upload(
                storage_path,
                handle.read(),
                {"content-type": "image/png", "upsert": "true"},
            )
        sticker_meta = {
            key: sticker.get(key)
            for key in (
                "concept", "symbol", "emotion_label", "emotion_intensity",
                "primary_color", "secondary_color", "highlight_color",
                "shadow_color", "color_rationale",
            )
        }
        return {"sticker_path": storage_path, "sticker": sticker_meta}


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/process-log")
def process_log(request: ProcessLogRequest) -> dict[str, Any]:
    response = (
        supabase.table("daily_logs")
        .select("*")
        .eq("id", request.log_id)
        .maybe_single()
        .execute()
    )
    log = response.data
    if not log:
        raise HTTPException(status_code=404, detail="log not found")

    image_path = _download_photo(log.get("photo_path") or "")
    try:
        update: dict[str, Any] = _run_intake(log, image_path)
        sticker = _run_sticker(log, update.get("emotion_scores") or {})
        if sticker:
            update.update(sticker)
        result = (
            supabase.table("daily_logs")
            .update(update)
            .eq("id", request.log_id)
            .execute()
        )
        rows = len(result.data or [])
        print(
            f"[service] updated log {request.log_id}: "
            f"rows={rows}, keys={list(update.keys())}, mood={update.get('mood_label')!r}"
        )
    finally:
        if image_path:
            Path(image_path).unlink(missing_ok=True)

    return {"ok": True, "updated_rows": rows, "updated": list(update.keys())}


@app.post("/generate-playlist")
def generate_playlist(request: GeneratePlaylistRequest) -> dict[str, Any]:
    """그날 로그마다 mood_music_agent로 추천 곡 1개씩 만들어 tracks에 저장(로그 1개=곡 1개)."""
    preferences = _load_music_preferences(request.user_id)
    logs = (
        supabase.table("daily_logs")
        .select("id, caption, situation, emotion_scores")
        .eq("user_id", request.user_id)
        .eq("log_date", request.date)
        .order("logged_at")
        .execute()
        .data
        or []
    )

    created = 0
    skipped = 0
    for log in logs:
        # 이미 이 로그에 곡이 있으면 건너뜀(tracks.log_id UNIQUE).
        existing = supabase.table("tracks").select("id").eq("log_id", log["id"]).execute().data
        if existing:
            skipped += 1
            continue

        situation = log.get("situation") or log.get("caption") or "오늘의 기록"
        emotions = log.get("emotion_scores") or {}
        try:
            result = recommend_music(situation, emotions, limit=1, preferences=preferences)
        except Exception as exc:  # 한 로그 실패가 전체를 막지 않도록.
            print(f"[service] recommend 실패 log {log['id']}: {exc}")
            continue
        recommendations = result.get("recommendations") or []
        if not recommendations:
            continue
        top = recommendations[0]
        supabase.table("tracks").insert(
            {
                "log_id": log["id"],
                "recco_track_id": top.get("id"),
                "title": top.get("title"),
                "artists": top.get("artists"),
                "spotify_url": top.get("spotify_url"),
                "duration_ms": top.get("duration_ms"),
                "popularity": top.get("popularity"),
                "audio_features": top.get("audio_features"),
                "fit_reason": top.get("fit_reason"),
            }
        ).execute()
        created += 1

    print(f"[service] generate-playlist {request.date}: created={created}, skipped={skipped}, logs={len(logs)}")
    return {"ok": True, "tracks_created": created, "tracks_skipped": skipped, "logs": len(logs)}

