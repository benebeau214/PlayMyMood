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
from datetime import date as calendar_date
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel
from supabase import create_client

from agent.mood_intake_agent import EmotionLog, analyze_daily_logs
from agent.mood_music_agent import (
    filter_tracks_by_emotion_compatibility,
    recommend_music,
    select_best_track,
    track_identity_keys,
)
from agent.spotify_track_validator import filter_playable_spotify_tracks

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
RECOMMENDATION_COOLDOWN_DAYS = 30

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
    spotify_access_token: str | None = None
    only_missing: bool = False


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


def _load_recent_recommended_track_ids(user_id: str, playlist_date: str) -> set[str]:
    target_date = calendar_date.fromisoformat(playlist_date)
    cooldown_start = target_date - timedelta(days=RECOMMENDATION_COOLDOWN_DAYS - 1)
    log_rows = (
        supabase.table("daily_logs")
        .select("id")
        .eq("user_id", user_id)
        .gte("log_date", cooldown_start.isoformat())
        .lte("log_date", target_date.isoformat())
        .execute()
        .data
        or []
    )
    log_ids = [str(row.get("id") or "") for row in log_rows if row.get("id")]
    if not log_ids:
        return set()

    track_rows = (
        supabase.table("tracks")
        .select("recco_track_id, spotify_url, title, artists")
        .in_("log_id", log_ids)
        .execute()
        .data
        or []
    )
    identities: set[str] = set()
    for track in track_rows:
        identities.update(track_identity_keys(track))
    return identities


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
    # Repeated labels are intentional: selecting the same emotion more than once
    # represents stronger emphasis for the intake agent.
    emotions = tuple(log.get("emotions") or [])
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
    recent_track_ids = _load_recent_recommended_track_ids(request.user_id, request.date)
    print(
        f"[service] recommendation cooldown: excluding "
        f"{len(recent_track_ids)} track(s) used in the last "
        f"{RECOMMENDATION_COOLDOWN_DAYS} days"
    )
    logs = (
        supabase.table("daily_logs")
        .select("id, caption, situation, image_context, emotion_scores")
        .eq("user_id", request.user_id)
        .eq("log_date", request.date)
        .order("logged_at")
        .execute()
        .data
        or []
    )

    created = 0
    replaced = 0
    skipped = 0
    failures: list[dict[str, str]] = []
    for log in logs:
        situation = log.get("situation") or log.get("caption") or "오늘의 기록"
        emotions = log.get("emotion_scores") or {}
        existing_rows = (
            supabase.table("tracks")
            .select(
                "id, recco_track_id, title, artists, spotify_url, duration_ms, "
                "popularity, audio_features, fit_reason"
            )
            .eq("log_id", log["id"])
            .execute()
            .data
            or []
        )
        existing = existing_rows[0] if existing_rows else None
        existing_has_recommendation = bool(
            existing
            and existing.get("title")
            and (existing.get("recco_track_id") or existing.get("spotify_url"))
        )
        if existing_has_recommendation and request.only_missing:
            skipped += 1
            continue
        if existing:
            current_candidate = {
                **existing,
                "id": existing.get("recco_track_id") or existing.get("id"),
            }
            playable_existing, _ = filter_playable_spotify_tracks(
                [current_candidate],
                request.spotify_access_token,
            )
            compatible_existing = filter_tracks_by_emotion_compatibility(
                playable_existing,
                emotions,
            )
            if compatible_existing:
                skipped += 1
                continue
            print(
                f"[service] replacing stale or mood-incompatible track "
                f"for log {log['id']}: {existing.get('title')}"
            )

        try:
            result = recommend_music(
                situation,
                emotions,
                limit=3,
                preferences=preferences,
                excluded_track_ids=recent_track_ids,
            )
        except Exception as exc:  # 한 로그 실패가 전체를 막지 않도록.
            print(f"[service] recommend 실패 log {log['id']}: {exc}")
            failures.append({
                "log_id": str(log["id"]),
                "stage": "recommend",
                "reason": str(exc),
            })
            continue
        recommendations = result.get("recommendations") or []
        if not recommendations:
            failures.append({
                "log_id": str(log["id"]),
                "stage": "candidates",
                "reason": "추천 후보가 생성되지 않았습니다.",
            })
            continue
        recommendations, playability = filter_playable_spotify_tracks(
            recommendations,
            request.spotify_access_token,
        )
        print(f"[service] Spotify playability log {log['id']}: {playability}")
        if not recommendations:
            print(f"[service] no playable Spotify candidates for log {log['id']}")
            failures.append({
                "log_id": str(log["id"]),
                "stage": "spotify_validation",
                "reason": "Spotify에서 사용할 수 있는 추천 후보가 없습니다.",
            })
            continue
        result = {**result, "recommendations": recommendations}
        top = recommendations[0]
        try:
            final_selection = select_best_track(
                situation,
                emotions,
                result,
                caption=log.get("caption") or "",
                image_context=log.get("image_context") or "",
            )
            top = final_selection["selected_track"]
            selection_reason = str(
                (final_selection.get("selection") or {}).get("reason") or ""
            ).strip()
            print(
                f"[service] final selection log {log['id']}: "
                f"{top.get('id')} from {final_selection.get('candidate_count')} candidates"
            )
        except Exception as exc:
            # A final-selection failure must not prevent playlist creation.
            selection_reason = ""
            print(
                f"[service] final selector failed log {log['id']}; "
                f"using ranked first candidate: {exc}"
            )
        track_payload = {
            "log_id": log["id"],
            "recco_track_id": top.get("id"),
            "title": top.get("title"),
            "artists": top.get("artists"),
            "spotify_url": top.get("spotify_url"),
            "duration_ms": top.get("duration_ms"),
            "popularity": top.get("popularity"),
            "audio_features": top.get("audio_features"),
            "fit_reason": selection_reason or top.get("fit_reason"),
        }
        try:
            if existing:
                (
                    supabase.table("tracks")
                    .update(track_payload)
                    .eq("id", existing["id"])
                    .execute()
                )
                replaced += 1
            else:
                supabase.table("tracks").insert(track_payload).execute()
                created += 1
            # Prevent duplicates between multiple new logs in this same request,
            # including cases where ReccoBeats returns another ID for the same
            # Spotify recording.
            recent_track_ids.update(track_identity_keys(top))
        except Exception as exc:
            print(f"[service] track save failed log {log['id']}: {exc}")
            failures.append({
                "log_id": str(log["id"]),
                "stage": "save",
                "reason": str(exc),
            })

    print(
        f"[service] generate-playlist {request.date}: created={created}, "
        f"replaced={replaced}, skipped={skipped}, logs={len(logs)}"
    )
    return {
        "ok": True,
        "tracks_created": created,
        "tracks_replaced": replaced,
        "tracks_skipped": skipped,
        "tracks_failed": len(failures),
        "failures": failures,
        "logs": len(logs),
    }

