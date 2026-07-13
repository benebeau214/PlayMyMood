"""Top-level mood intake agent for per-log emotion analysis.

This agent turns each user log into a stable payload for downstream agents:
- one music_agent_input per log: situation + numeric emotion scores
- one cover_agent_input per log: visual direction for an album-cover agent
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from agent.mood_music_agent import (
    ConfigurationError,
    ModelOutputError,
    extract_json_object,
    load_env_file,
)


DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5"
EMOTION_KEYS = (
    "joy",
    "sadness",
    "anger",
    "anxiety",
    "calm",
    "tired",
    "excitement",
    "loneliness",
    "confidence",
    "focus",
)
CUSTOM_EMOTION_LABELS = (
    "행복한",
    "신나는",
    "설레는",
    "기쁜",
    "뿌듯한",
    "감동한",
    "편안한",
    "후련한",
    "만족한",
    "짜릿한",
    "안도감",
    "그리운",
    "아련한",
    "뭉클한",
    "우울한",
    "외로운",
    "속상한",
    "허무한",
    "피곤한",
    "짜증난",
    "화난",
    "불안한",
    "괴로운",
)
CUSTOM_EMOTION_PRIORS: dict[str, dict[str, float]] = {
    "행복한": {"joy": 0.9, "valence_hint": 0.9, "energy_hint": 0.55},
    "신나는": {"joy": 0.75, "excitement": 0.9, "energy_hint": 0.9},
    "설레는": {"joy": 0.65, "excitement": 0.8, "anxiety": 0.15},
    "기쁜": {"joy": 0.85, "excitement": 0.55},
    "뿌듯한": {"joy": 0.65, "confidence": 0.9, "focus": 0.45},
    "감동한": {"joy": 0.55, "sadness": 0.18, "calm": 0.35},
    "편안한": {"calm": 0.9, "joy": 0.35, "energy_hint": 0.25},
    "후련한": {"calm": 0.65, "joy": 0.45, "confidence": 0.45},
    "만족한": {"joy": 0.6, "calm": 0.55, "confidence": 0.65},
    "짜릿한": {"excitement": 0.95, "joy": 0.6, "energy_hint": 0.95},
    "안도감": {"calm": 0.75, "joy": 0.35, "anxiety": 0.1},
    "그리운": {"sadness": 0.45, "loneliness": 0.4, "calm": 0.35},
    "아련한": {"sadness": 0.35, "calm": 0.45, "loneliness": 0.25},
    "뭉클한": {"joy": 0.35, "sadness": 0.28, "calm": 0.45},
    "우울한": {"sadness": 0.85, "tired": 0.45, "loneliness": 0.45},
    "외로운": {"loneliness": 0.9, "sadness": 0.6, "calm": 0.2},
    "속상한": {"sadness": 0.75, "anger": 0.2, "anxiety": 0.25},
    "허무한": {"sadness": 0.55, "tired": 0.45, "loneliness": 0.35},
    "피곤한": {"tired": 0.9, "sadness": 0.25, "focus": 0.15},
    "짜증난": {"anger": 0.65, "anxiety": 0.25, "tired": 0.35},
    "화난": {"anger": 0.9, "energy_hint": 0.75},
    "불안한": {"anxiety": 0.9, "focus": 0.25, "sadness": 0.25},
    "괴로운": {"sadness": 0.7, "anxiety": 0.55, "tired": 0.45},
}
SUPPORTED_IMAGE_MEDIA_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


@dataclass(frozen=True)
class EmotionLog:
    caption: str = ""
    emoji: str = ""
    image_path: str | None = None
    created_at: str | None = None


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def normalize_emotions(raw: Any, emoji_label: str = "") -> dict[str, float]:
    if not isinstance(raw, dict):
        raw = {}
    prior = CUSTOM_EMOTION_PRIORS.get(emoji_label, {})
    normalized: dict[str, float] = {}
    for key in EMOTION_KEYS:
        value = raw.get(key, prior.get(key, 0.0))
        if isinstance(value, int | float):
            normalized[key] = round(clamp01(float(value)), 3)
        else:
            normalized[key] = 0.0
    return normalized


def normalize_text(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text if text else fallback


def parse_logs_text(text: str) -> list[EmotionLog]:
    if not text.strip():
        raise ValueError("logs JSON must be non-empty")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"logs must be valid JSON: {exc}") from exc
    if not isinstance(raw, list):
        raise ValueError("logs JSON must be a list")

    logs: list[EmotionLog] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"log at index {index} must be an object")
        emoji = str(item.get("emoji") or item.get("emotion_label") or "").strip()
        if emoji and emoji not in CUSTOM_EMOTION_LABELS:
            raise ValueError(
                f"log at index {index} has unsupported emoji/emotion label: {emoji}. "
                f"Allowed labels: {', '.join(CUSTOM_EMOTION_LABELS)}"
            )
        logs.append(
            EmotionLog(
                caption=str(item.get("caption") or item.get("message") or ""),
                emoji=emoji,
                image_path=item.get("image_path"),
                created_at=item.get("created_at"),
            )
        )
    if not logs:
        raise ValueError("logs JSON must include at least one log")
    return logs


def image_to_anthropic_source(image_path: str) -> dict[str, str]:
    if not os.path.exists(image_path):
        raise ValueError(f"image not found: {image_path}")
    media_type = mimetypes.guess_type(image_path)[0] or "application/octet-stream"
    if media_type not in SUPPORTED_IMAGE_MEDIA_TYPES:
        raise ValueError(f"unsupported image type for {image_path}: {media_type}")
    with open(image_path, "rb") as handle:
        data = base64.b64encode(handle.read()).decode("ascii")
    return {"type": "base64", "media_type": media_type, "data": data}


def _json_request(request: urllib.request.Request, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ModelOutputError(f"Claude HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise ModelOutputError(f"Claude network error: {exc.reason}") from exc
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ModelOutputError(f"Claude response was not JSON: {body[:200]}") from exc
    if not isinstance(parsed, dict):
        raise ModelOutputError("Claude response JSON must be an object")
    return parsed


class AnthropicEmotionIntakeClient:
    def __init__(self, api_key: str | None = None, model: str | None = None, timeout: int = 45) -> None:
        env_file = load_env_file()
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY") or env_file.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise ConfigurationError("ANTHROPIC_API_KEY is missing")
        self.model = model or os.environ.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL
        self.timeout = timeout

    def analyze_logs(self, logs: list[EmotionLog]) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": build_analysis_prompt(logs)}]
        for index, log in enumerate(logs, start=1):
            if not log.image_path:
                continue
            source = image_to_anthropic_source(log.image_path)
            content.append({"type": "text", "text": f"Image for log {index}. Use it for situation and atmosphere analysis only:"})
            content.append({"type": "image", "source": source})

        payload = {
            "model": self.model,
            "max_tokens": 1800,
            "temperature": 0.2,
            "system": (
                "You are an emotion scoring agent for a diary-to-music product. "
                "Analyze each log independently. Use images for visible situation, setting, color, and atmosphere. "
                "Return only one JSON object."
            ),
            "messages": [{"role": "user", "content": content}],
        }
        request = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        response = _json_request(request, self.timeout)
        text_parts = [
            block.get("text", "")
            for block in response.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return extract_json_object("\n".join(text_parts))


def build_analysis_prompt(logs: list[EmotionLog]) -> str:
    compact_logs = [
        {
            "log_index": index,
            "created_at": log.created_at,
            "caption": log.caption,
            "selected_emotion_label": log.emoji,
            "has_image": bool(log.image_path),
        }
        for index, log in enumerate(logs, start=1)
    ]
    return (
        "Analyze each emotion log independently and produce one song-mapping payload per log.\n"
        f"Allowed selected_emotion_label values: {', '.join(CUSTOM_EMOTION_LABELS)}.\n"
        f"Logs JSON: {json.dumps(compact_logs, ensure_ascii=False, sort_keys=True)}\n\n"
        "Rules:\n"
        "- Do not summarize the whole day into one mood. Each log gets its own analysis and one music_agent_input.\n"
        "- The user's selected_emotion_label is strong evidence, but captions and images may refine intensity.\n"
        "- Images must be used for situation and atmosphere only: visible place, objects, lighting, color, weather, activity, and mood.\n"
        "- Do not infer private identity, sensitive traits, or exact mental-health conditions from images.\n"
        "- emotions must contain exactly these keys with values from 0.0 to 1.0: "
        f"{', '.join(EMOTION_KEYS)}.\n"
        "- music_agent_input.situation should be one natural Korean sentence for that log only.\n"
        "- cover_agent_input.visual_prompt should be an English image-generation prompt for a square album cover inspired by that log.\n\n"
        "Return exactly this JSON shape:\n"
        "{"
        "\"log_results\":["
        "{"
        "\"log_index\":1,"
        "\"selected_emotion_label\":\"행복한\","
        "\"mood_label\":\"short Korean mood label\","
        "\"situation\":\"Korean sentence for this log\","
        "\"image_context\":\"Korean visible situation/atmosphere summary, empty string if no image\","
        "\"emotions\":{\"joy\":0,\"sadness\":0,\"anger\":0,\"anxiety\":0,\"calm\":0,\"tired\":0,\"excitement\":0,\"loneliness\":0,\"confidence\":0,\"focus\":0},"
        "\"music_agent_input\":{\"situation\":\"Korean sentence for this log\",\"emotions\":{\"joy\":0,\"sadness\":0,\"anger\":0,\"anxiety\":0,\"calm\":0,\"tired\":0,\"excitement\":0,\"loneliness\":0,\"confidence\":0,\"focus\":0}},"
        "\"cover_agent_input\":{\"title\":\"short title\",\"visual_prompt\":\"English prompt\",\"palette\":[\"#RRGGBB\"],\"keywords\":[\"word\"]},"
        "\"evidence\":[\"brief Korean evidence\"],"
        "\"warnings\":[\"brief Korean warning if any\"]"
        "}"
        "]}"
    )


def fallback_emotions_for_log(log: EmotionLog) -> dict[str, float]:
    scores = {key: 0.0 for key in EMOTION_KEYS}
    for key, value in CUSTOM_EMOTION_PRIORS.get(log.emoji, {}).items():
        if key in scores:
            scores[key] = max(scores[key], clamp01(value))

    text = f"{log.caption} {log.emoji}".lower()
    cues = {
        "joy": ("좋", "행복", "웃", "기쁜", "만족"),
        "sadness": ("슬", "우울", "눈물", "힘들", "속상"),
        "anger": ("화", "짜증", "열받", "분노"),
        "anxiety": ("불안", "걱정", "초조", "긴장"),
        "calm": ("평온", "차분", "잔잔", "휴식", "편안"),
        "tired": ("피곤", "지침", "졸", "번아웃"),
        "excitement": ("신나", "설렘", "기대", "짜릿"),
        "loneliness": ("혼자", "외로", "쓸쓸", "고독"),
        "confidence": ("해냈", "성공", "뿌듯", "자신"),
        "focus": ("집중", "공부", "작업", "마감", "과제"),
    }
    for key, terms in cues.items():
        if any(term in text for term in terms):
            scores[key] = max(scores[key], 0.55)
    if not any(scores.values()):
        scores["calm"] = 0.35
    return {key: round(clamp01(value), 3) for key, value in scores.items()}


def normalize_cover_input(raw: Any, mood_label: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    palette = raw.get("palette")
    if not isinstance(palette, list):
        palette = []
    colors = [str(color) for color in palette if re.fullmatch(r"#[0-9a-fA-F]{6}", str(color))]
    keywords = raw.get("keywords")
    if not isinstance(keywords, list):
        keywords = []
    visual_prompt = normalize_text(
        raw.get("visual_prompt"),
        f"Square album cover for a {mood_label} diary moment, atmospheric, no text.",
    )
    return {
        "title": normalize_text(raw.get("title"), mood_label or "Moment"),
        "visual_prompt": visual_prompt,
        "palette": colors[:5],
        "keywords": [str(item).strip() for item in keywords if str(item).strip()][:8],
        "avoid": "text, watermark, logo, realistic identifiable faces",
        "aspect_ratio": "1:1",
    }


def normalize_log_result(raw: Any, log: EmotionLog, expected_index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    selected_label = normalize_text(raw.get("selected_emotion_label"), log.emoji)
    if selected_label not in CUSTOM_EMOTION_LABELS:
        selected_label = log.emoji if log.emoji in CUSTOM_EMOTION_LABELS else ""

    fallback_emotions = fallback_emotions_for_log(log)
    emotions = normalize_emotions(raw.get("emotions") or fallback_emotions, selected_label)
    if not any(emotions.values()):
        emotions = fallback_emotions

    mood_label = normalize_text(raw.get("mood_label"), selected_label or "복합적인 감정")
    situation = normalize_text(raw.get("situation"), log.caption or mood_label)
    image_context = normalize_text(raw.get("image_context"), "")
    cover_input = normalize_cover_input(raw.get("cover_agent_input"), mood_label)

    music_input = raw.get("music_agent_input")
    if not isinstance(music_input, dict):
        music_input = {}
    music_situation = normalize_text(music_input.get("situation"), situation)
    music_emotions = normalize_emotions(music_input.get("emotions") or emotions, selected_label)
    if not any(music_emotions.values()):
        music_emotions = emotions

    evidence = raw.get("evidence")
    if not isinstance(evidence, list):
        evidence = []
    warnings = raw.get("warnings")
    if not isinstance(warnings, list):
        warnings = []

    return {
        "log_index": expected_index,
        "created_at": log.created_at,
        "caption": log.caption,
        "selected_emotion_label": selected_label,
        "mood_label": mood_label,
        "situation": situation,
        "image_context": image_context,
        "emotions": emotions,
        "music_agent_input": {
            "situation": music_situation,
            "emotions": music_emotions,
        },
        "cover_agent_input": cover_input,
        "evidence": [str(item) for item in evidence],
        "warnings": [str(item) for item in warnings],
    }


def normalize_analysis(raw: dict[str, Any], logs: list[EmotionLog]) -> dict[str, Any]:
    raw_results = raw.get("log_results") if isinstance(raw, dict) else None
    if not isinstance(raw_results, list):
        raw_results = []

    by_index: dict[int, Any] = {}
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        raw_index = item.get("log_index")
        if isinstance(raw_index, int):
            by_index[raw_index] = item

    log_results = [
        normalize_log_result(by_index.get(index, {}), log, index)
        for index, log in enumerate(logs, start=1)
    ]
    return {
        "log_results": log_results,
        "music_agent_inputs": [item["music_agent_input"] for item in log_results],
        "cover_agent_inputs": [item["cover_agent_input"] for item in log_results],
        "sources": {
            "emotion_labels": list(CUSTOM_EMOTION_LABELS),
            "mapping": "one_log_to_one_song",
            "image_usage": "situation_and_atmosphere_analysis_only",
        },
    }


def analyze_daily_logs(
    logs: list[EmotionLog],
    *,
    client: Any | None = None,
) -> dict[str, Any]:
    if not logs:
        raise ValueError("logs must include at least one log")
    analyzer = client or AnthropicEmotionIntakeClient()
    raw = analyzer.analyze_logs(logs)
    return normalize_analysis(raw, logs)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze emotion logs one by one for music and cover agents.")
    parser.add_argument(
        "--logs-json",
        required=True,
        help='JSON list of logs, e.g. [{"caption":"...", "emoji":"행복한", "image_path":"photo.jpg"}]',
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        logs = parse_logs_text(args.logs_json)
        result = analyze_daily_logs(logs)
    except (ValueError, ConfigurationError, ModelOutputError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
