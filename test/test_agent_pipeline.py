"""End-to-end test runner for PlayMyMood agents.

Flow:
1. photo path + caption + selected emotion label(s)
2. Claude emotion intake agent
3. music agent mood profile + ReccoBeats recommendation
4. print one JSON result

Example:
python test/test_agent_pipeline.py --image ./sample.jpg --caption "발표 끝나고 너무 뿌듯했다" --emoji "뿌듯한" --emoji "후련한" --limit 3
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Make this script runnable from project root or from test/.
TEST_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TEST_DIR.parent
AGENT_DIR = PROJECT_ROOT / "agent"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from mood_intake_agent import (  # noqa: E402
    CUSTOM_EMOTION_LABELS,
    EmotionLog,
    analyze_daily_logs,
)
import mood_music_agent as music_agent  # noqa: E402
from mood_music_agent import (  # noqa: E402
    DEFAULT_CLAUDE_MODEL,
    ConfigurationError,
    ModelOutputError,
    ReccoBeatsError,
    extract_json_object,
    parse_env_text,
)



TEST_FIXED_POPULARITY = 80.0


def install_test_popularity_override() -> None:
    """Force ReccoBeats popularity target to 80 only in this test runner."""
    original_complete_target_features = music_agent.complete_target_features

    def complete_target_features_with_fixed_popularity(profile: dict[str, Any], emotions: dict[str, float]) -> dict[str, float]:
        features = original_complete_target_features(profile, emotions)
        features["popularity"] = TEST_FIXED_POPULARITY
        return features

    music_agent.complete_target_features = complete_target_features_with_fixed_popularity

def load_dotenv_candidates() -> None:
    """Load simple KEY=VALUE files without requiring python-dotenv."""
    for path in (PROJECT_ROOT / ".env", AGENT_DIR / ".env", TEST_DIR / ".env"):
        if not path.exists():
            continue
        env_values = parse_env_text(path.read_text(encoding="utf-8"))
        for key, value in env_values.items():
            os.environ.setdefault(key, value)


def resolve_optional_path(raw_path: str | None) -> str | None:
    if not raw_path:
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"image file not found: {path}")
    return str(path)


def first_music_input(intake_result: dict[str, Any]) -> dict[str, Any]:
    log_results = intake_result.get("log_results")
    if isinstance(log_results, list) and log_results:
        first = log_results[0]
        if isinstance(first, dict) and isinstance(first.get("music_agent_input"), dict):
            return first["music_agent_input"]

    music_inputs = intake_result.get("music_agent_inputs")
    if isinstance(music_inputs, list) and music_inputs and isinstance(music_inputs[0], dict):
        return music_inputs[0]

    raise ModelOutputError("intake result did not include a usable music_agent_input")

def compact_track_for_selection(track: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": track.get("id"),
        "title": track.get("title"),
        "artists": track.get("artists", []),
        "spotify_url": track.get("spotify_url"),
        "popularity": track.get("popularity"),
        "available_in_preferred_country": track.get("available_in_preferred_country"),
        "audio_features": {
            key: (track.get("audio_features") or {}).get(key)
            for key in ("valence", "danceability", "energy", "tempo", "acousticness", "instrumentalness", "speechiness", "loudness")
        },
    }


def call_claude_json(payload: dict[str, Any], timeout: int = 45) -> dict[str, Any]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ConfigurationError("ANTHROPIC_API_KEY is missing")
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ModelOutputError(f"Claude selector HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise ModelOutputError(f"Claude selector network error: {exc.reason}") from exc

    parsed = json.loads(body)
    text_parts = [
        block.get("text", "")
        for block in parsed.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return extract_json_object("\n".join(text_parts))


def pick_best_track_with_claude(
    situation: str,
    emotions: dict[str, Any],
    music_result: dict[str, Any],
) -> dict[str, Any]:
    candidates = [
        compact_track_for_selection(track)
        for track in music_result.get("recommendations", [])
        if isinstance(track, dict) and track.get("id")
    ]
    if not candidates:
        raise ModelOutputError("no recommendation candidates to select from")

    mood_profile = music_result.get("mood_profile", {})
    target_features = {}
    if isinstance(mood_profile, dict):
        target_features = mood_profile.get("target_audio_features") or {}

    payload = {
        "model": os.environ.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL,
        "max_tokens": 500,
        "temperature": 0.0,
        "system": (
            "You are a strict final song selector for a diary-to-music app. "
            "Return only one JSON object. Judge only from the provided metadata and audio features."
        ),
        "messages": [
            {
                "role": "user",
                "content": (
                    "Choose exactly one track from the candidates for this single user log.\n"
                    f"Situation: {situation}\n"
                    f"Emotion scores JSON: {json.dumps(emotions, ensure_ascii=False, sort_keys=True)}\n"
                    f"Target audio features JSON: {json.dumps(target_features, ensure_ascii=False, sort_keys=True)}\n"
                    f"Candidates JSON: {json.dumps(candidates, ensure_ascii=False, sort_keys=True)}\n\n"
                    "Selection rules:\n"
                    "- Prefer the track that best matches the situation and emotion scores.\n"
                    "- For study/focus logs, avoid tracks likely to be distracting: very high danceability, high speechiness, or overly bright mood.\n"
                    "- Balance fatigue: avoid music that is too sleepy unless the log asks for rest.\n"
                    "- Use audio_features and title/artist metadata only. Do not invent facts.\n"
                    "- Return exactly: {\"selected_track_id\":\"id\",\"reason\":\"Korean reason\"}"
                ),
            }
        ],
    }
    selection = call_claude_json(payload)
    selected_id = str(selection.get("selected_track_id") or "")
    selected_track = next((track for track in candidates if str(track.get("id")) == selected_id), None)
    if not selected_track:
        selected_track = candidates[0]
        selection = {
            "selected_track_id": selected_track.get("id"),
            "reason": "Claude selector returned an unknown id, so the top-ranked recommendation was used.",
        }
    return {
        "selected_track": selected_track,
        "selection": selection,
        "candidate_count": len(candidates),
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Claude intake agent and ReccoBeats music recommendation end-to-end.")
    parser.add_argument("--image", default="", help="Optional image path for the uploaded photo.")
    parser.add_argument("--caption", required=True, help="User caption/message for the log.")
    parser.add_argument(
        "--emoji",
        required=True,
        action="append",
        choices=CUSTOM_EMOTION_LABELS,
        help="Selected emotion label. Repeat this option for multiple selected emojis.",
    )
    parser.add_argument("--limit", type=int, default=5, help="Number of songs to recommend. 1-25.")
    parser.add_argument(
        "--preferences-json",
        default="{}",
        help="Optional music preferences JSON, e.g. '{\"preferred_genres\":[\"KPOP\"]}'.",
    )
    parser.add_argument("--output", default="", help="Optional path to save the full JSON result.")
    parser.add_argument(
        "--pick-best",
        action="store_true",
        help="After ReccoBeats returns candidates, ask Claude to choose the single best track.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        load_dotenv_candidates()
        install_test_popularity_override()
        preferences = json.loads(args.preferences_json)
        if not isinstance(preferences, dict):
            raise ValueError("--preferences-json must be a JSON object")

        selected_emojis = list(dict.fromkeys(args.emoji))
        primary_emoji = selected_emojis[0]
        enriched_caption = args.caption
        if len(selected_emojis) > 1:
            enriched_caption = f"{args.caption}\n선택한 감정 이모지들: {', '.join(selected_emojis)}"

        log = EmotionLog(
            caption=enriched_caption,
            emoji=primary_emoji,
            image_path=resolve_optional_path(args.image),
        )

        print("[1/4] Claude로 사진/캡션/이모지 감정 분석 중...", file=sys.stderr)
        intake_result = analyze_daily_logs([log])
        music_input = first_music_input(intake_result)
        situation = str(music_input.get("situation") or enriched_caption)
        emotions = music_input.get("emotions")
        if not isinstance(emotions, dict):
            raise ModelOutputError("music_agent_input.emotions must be an object")

        print("[2/4] 감정 점수를 음악 추천 입력으로 변환 완료", file=sys.stderr)
        print("[3/4] ReccoBeats API로 추천곡 조회 중...", file=sys.stderr)
        numeric_emotions = {key: float(value) for key, value in emotions.items()}
        music_result = music_agent.recommend_music(
            situation=situation,
            emotions=numeric_emotions,
            limit=args.limit,
            preferences=preferences,
        )

        best_track_result = None
        if args.pick_best:
            print("[4/4] Claude가 후보곡 중 최종 1곡을 고르는 중...", file=sys.stderr)
            best_track_result = pick_best_track_with_claude(situation, numeric_emotions, music_result)

        result = {
            "input": {
                "caption": args.caption,
                "emojis": selected_emojis,
                "primary_emoji": primary_emoji,
                "image": log.image_path,
                "limit": args.limit,
                "preferences": preferences,
            },
            "intake_result": intake_result,
            "music_agent_input": {
                "situation": situation,
                "emotions": emotions,
            },
            "music_result": music_result,
            "best_track_result": best_track_result,
        }

        output_text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            output_path = Path(args.output)
            if not output_path.is_absolute():
                output_path = (Path.cwd() / output_path).resolve()
            output_path.write_text(output_text, encoding="utf-8")
            print(f"saved result: {output_path}", file=sys.stderr)
        print(output_text)
        return 0
    except (ConfigurationError, ModelOutputError, ReccoBeatsError, ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())






