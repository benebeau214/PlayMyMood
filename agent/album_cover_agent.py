"""Generate a daily playlist cover from a mood-music recommendation result."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5"
REPLICATE_MODEL = "google/nano-banana-2"
REPLICATE_PREDICTIONS_URL = (
    "https://api.replicate.com/v1/models/google/nano-banana-2/predictions"
)

STYLE_ALIASES = {
    "anime": "anime",
    "애니메": "anime",
    "애니메이션": "anime",
    "realistic": "realistic",
    "리얼리스틱": "realistic",
    "실사": "realistic",
    "emotional": "emotional",
    "감성": "emotional",
    "artistic": "artistic",
    "아티스틱": "artistic",
    "예술적": "artistic",
}

STYLE_DIRECTIONS = {
    "anime": (
        "an original anime-inspired editorial illustration with expressive composition, "
        "clean shapes, controlled cel shading, and cinematic light"
    ),
    "realistic": (
        "a cinematic, realistic editorial photograph with natural textures, purposeful "
        "camera language, and subtle film grain"
    ),
    "emotional": (
        "a poetic and atmospheric album artwork with restrained composition, soft sensory "
        "details, and an intimate emotional tone"
    ),
    "artistic": (
        "an experimental fine-art album artwork using expressive abstraction, tactile "
        "mixed-media textures, and a deliberate gallery-quality composition"
    ),
}


class ConfigurationError(RuntimeError):
    """Raised when an API credential is missing."""


class ModelOutputError(RuntimeError):
    """Raised when Claude returns an unusable cover brief."""


class ApiRequestError(RuntimeError):
    """Raised when an external API request fails."""


class RateLimitError(ApiRequestError):
    """Raised when an API asks the client to retry after a delay."""

    def __init__(self, message: str, retry_after: float = 10.0) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ImageGenerationError(RuntimeError):
    """Raised when Replicate cannot generate or return an image."""


def normalize_style(value: str) -> str:
    normalized = STYLE_ALIASES.get(str(value).strip().lower())
    if not normalized:
        supported = ", ".join(("anime", "realistic", "emotional", "artistic"))
        raise ValueError(f"cover_style must be one of: {supported}")
    return normalized


def normalize_emotions(raw_emotions: Any) -> dict[str, float]:
    if not isinstance(raw_emotions, dict):
        raise ValueError("emotions must be an object")
    emotions: dict[str, float] = {}
    for raw_name, raw_value in raw_emotions.items():
        name = str(raw_name).strip()
        if not name:
            raise ValueError("emotion names must be non-empty")
        if not isinstance(raw_value, int | float):
            raise ValueError(f"emotion '{name}' must be numeric")
        value = float(raw_value)
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"emotion '{name}' must be between 0.0 and 1.0")
        emotions[name] = value
    return emotions


def parse_emotion_args(raw_emotions: list[str]) -> dict[str, float]:
    emotions: dict[str, float] = {}
    for raw in raw_emotions:
        if "=" not in raw:
            raise ValueError(f"emotion must use name=value format: {raw}")
        name, value_text = raw.split("=", 1)
        try:
            value = float(value_text)
        except ValueError as exc:
            raise ValueError(f"emotion '{name.strip()}' must be numeric") from exc
        emotions[name.strip()] = value
    return normalize_emotions(emotions)


def compact_recommendations(music_result: Any) -> list[dict[str, Any]]:
    if not isinstance(music_result, dict):
        raise ValueError("music_result must be an object")
    raw_tracks = music_result.get("recommendations")
    if not isinstance(raw_tracks, list) or not raw_tracks:
        raise ValueError("music_result must include at least one recommendation")

    tracks: list[dict[str, Any]] = []
    for raw_track in raw_tracks:
        if not isinstance(raw_track, dict):
            continue
        title = str(raw_track.get("title") or "").strip()
        if not title:
            continue
        raw_artists = raw_track.get("artists") or []
        artists = (
            [str(artist).strip() for artist in raw_artists if str(artist).strip()]
            if isinstance(raw_artists, list)
            else []
        )
        tracks.append(
            {
                "title": title,
                "artists": artists,
                "fit_reason": str(raw_track.get("fit_reason") or ""),
                "audio_features": raw_track.get("audio_features") or {},
            }
        )
    if not tracks:
        raise ValueError("music_result recommendations contain no usable tracks")
    return tracks


def validate_inputs(
    situation: str,
    emotions: Any,
    music_result: Any,
    cover_style: str,
) -> tuple[dict[str, float], list[dict[str, Any]], str]:
    if not situation or not situation.strip():
        raise ValueError("situation must be non-empty")
    normalized_emotions = normalize_emotions(emotions)
    recommendations = compact_recommendations(music_result)
    style = normalize_style(cover_style)
    return normalized_emotions, recommendations, style


def parse_env_text(text: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        delimiter = "=" if "=" in line else ":" if ":" in line else None
        if not delimiter:
            continue
        raw_key, raw_value = line.split(delimiter, 1)
        key = re.sub(r"[^a-z0-9]+", "_", raw_key.lower()).strip("_")
        value = raw_value.strip().strip("'\"")
        if ("anthropic" in key or "claude" in key) and ("key" in key or "token" in key):
            env["ANTHROPIC_API_KEY"] = value
        if "replicate" in key and ("key" in key or "token" in key):
            env["REPLICATE_API_TOKEN"] = value
    return env


def load_env_file(path: str = ".env") -> dict[str, str]:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return parse_env_text(handle.read())


def extract_json_object(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ModelOutputError("Claude response did not contain a JSON object")
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ModelOutputError(f"Claude response contained invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ModelOutputError("Claude response JSON must be an object")
    return parsed


def normalize_cover_brief(raw_brief: Any) -> dict[str, Any]:
    if not isinstance(raw_brief, dict):
        raise ModelOutputError("Claude cover brief must be an object")
    visual_summary = str(raw_brief.get("visual_summary") or "").strip()
    image_prompt = str(raw_brief.get("image_prompt") or "").strip()
    design_notes = raw_brief.get("design_notes") or {}
    if not visual_summary:
        raise ModelOutputError("Claude cover brief must include visual_summary")
    if not image_prompt:
        raise ModelOutputError("Claude cover brief must include image_prompt")
    if not isinstance(design_notes, dict):
        raise ModelOutputError("Claude cover brief design_notes must be an object")
    return {
        "visual_summary": visual_summary,
        "image_prompt": image_prompt,
        "design_notes": design_notes,
    }


def _json_request(request: urllib.request.Request, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 429:
            retry_after = 10.0
            try:
                error_body = json.loads(body)
                retry_after = float(error_body.get("retry_after") or retry_after)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
            raise RateLimitError(f"HTTP 429: {body}", retry_after) from exc
        raise ApiRequestError(f"HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise ApiRequestError(f"Network error: {exc.reason}") from exc
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiRequestError(f"Response was not JSON: {body[:200]}") from exc
    if not isinstance(parsed, dict):
        raise ApiRequestError("Response JSON must be an object")
    return parsed


class AnthropicCoverClient:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        timeout: int = 45,
    ) -> None:
        env_file = load_env_file()
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY") or env_file.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise ConfigurationError("ANTHROPIC_API_KEY is missing")
        self.model = model or os.environ.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL
        self.timeout = timeout

    def create_cover_brief(
        self,
        situation: str,
        emotions: dict[str, float],
        mood_profile: dict[str, Any],
        recommendations: list[dict[str, Any]],
        cover_style: str,
    ) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "max_tokens": 1200,
            "temperature": 0.6,
            "system": (
                "You are the visual director for a daily music diary app. Create one cohesive "
                "playlist-cover concept that summarizes the user's day and the playlist as a whole, "
                "never one specific song. Return only one JSON object. Do not imitate named artists, "
                "copyrighted franchises, or existing album covers."
            ),
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Design the cover for today's music-diary playlist.\n"
                        f"Situation: {situation}\n"
                        f"Emotion scores JSON: {json.dumps(emotions, ensure_ascii=False, sort_keys=True)}\n"
                        f"Mood profile JSON: {json.dumps(mood_profile, ensure_ascii=False, sort_keys=True)}\n"
                        f"Playlist tracks JSON: {json.dumps(recommendations, ensure_ascii=False, sort_keys=True)}\n"
                        f"Selected cover style: {cover_style}\n"
                        f"Style direction: {STYLE_DIRECTIONS[cover_style]}\n\n"
                        "Build the image prompt using these rules:\n"
                        "- Describe one coherent scene in a natural, narrative paragraph instead of listing keywords.\n"
                        "- Explain that the image is a daily music-diary playlist cover and convey the emotional arc shared by the tracks.\n"
                        "- Be specific about subject, action, environment, composition, palette, lighting, medium, texture, and camera language when relevant.\n"
                        "- Use positive semantic descriptions for the desired scene.\n"
                        "- Compose explicitly for a square 1:1 album cover that remains legible as a small thumbnail.\n"
                        "- The final artwork contains imagery only; the app adds all title, date, logo, and typography later.\n"
                        "- Write visual_summary in Korean and image_prompt in English.\n"
                        "Return exactly this shape: "
                        "{\"visual_summary\":\"...\",\"image_prompt\":\"...\","
                        "\"design_notes\":{\"palette\":[\"...\"],\"composition\":\"...\","
                        "\"lighting\":\"...\",\"medium\":\"...\"}}"
                    ),
                }
            ],
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
        return normalize_cover_brief(extract_json_object("\n".join(text_parts)))


def build_replicate_input(image_prompt: str) -> dict[str, Any]:
    if not image_prompt or not image_prompt.strip():
        raise ValueError("image_prompt must be non-empty")
    return {
        "prompt": image_prompt.strip(),
        "aspect_ratio": "1:1",
        "resolution": "1K",
        "output_format": "png",
        "google_search": False,
        "image_search": False,
    }


class ReplicateImageClient:
    def __init__(
        self,
        api_token: str | None = None,
        request_timeout: int = 75,
        poll_timeout: int = 180,
        max_rate_limit_retries: int = 3,
    ) -> None:
        env_file = load_env_file()
        self.api_token = (
            api_token
            or os.environ.get("REPLICATE_API_TOKEN")
            or env_file.get("REPLICATE_API_TOKEN")
        )
        if not self.api_token:
            raise ConfigurationError("REPLICATE_API_TOKEN is missing")
        self.model = REPLICATE_MODEL
        self.request_timeout = request_timeout
        self.poll_timeout = poll_timeout
        self.max_rate_limit_retries = max_rate_limit_retries

    def generate_image(self, image_prompt: str) -> str:
        request = urllib.request.Request(
            REPLICATE_PREDICTIONS_URL,
            data=json.dumps({"input": build_replicate_input(image_prompt)}).encode("utf-8"),
            headers={
                "authorization": f"Bearer {self.api_token}",
                "content-type": "application/json",
                "prefer": "wait=60",
            },
            method="POST",
        )
        for attempt in range(self.max_rate_limit_retries + 1):
            try:
                prediction = _json_request(request, self.request_timeout)
                break
            except RateLimitError as exc:
                if attempt >= self.max_rate_limit_retries:
                    raise
                time.sleep(max(exc.retry_after, 1.0))
        deadline = time.monotonic() + self.poll_timeout
        while prediction.get("status") in ("starting", "processing"):
            if time.monotonic() >= deadline:
                raise ImageGenerationError("Replicate prediction timed out")
            prediction_url = (prediction.get("urls") or {}).get("get")
            if not isinstance(prediction_url, str) or not prediction_url:
                raise ImageGenerationError("Replicate prediction is missing its status URL")
            time.sleep(1)
            poll_request = urllib.request.Request(
                prediction_url,
                headers={"authorization": f"Bearer {self.api_token}"},
                method="GET",
            )
            prediction = _json_request(poll_request, self.request_timeout)

        if prediction.get("status") != "succeeded":
            error = prediction.get("error") or f"status={prediction.get('status')}"
            raise ImageGenerationError(f"Replicate prediction failed: {error}")
        output = prediction.get("output")
        if not isinstance(output, str) or not output:
            raise ImageGenerationError("Replicate prediction returned no image URL")
        return output

    def download_image(self, image_url: str, output_path: str) -> str:
        path = Path(output_path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(image_url, headers={"user-agent": "PlaylistCoverAgent/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=self.request_timeout) as response:
                path.write_bytes(response.read())
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise ImageGenerationError(f"Could not download generated image: {exc}") from exc
        return str(path)


def generate_playlist_cover(
    situation: str,
    emotions: dict[str, float],
    music_result: dict[str, Any],
    cover_style: str,
    *,
    output_path: str | None = None,
    claude_client: Any | None = None,
    image_client: Any | None = None,
) -> dict[str, Any]:
    normalized_emotions, recommendations, style = validate_inputs(
        situation,
        emotions,
        music_result,
        cover_style,
    )
    mood_profile = music_result.get("mood_profile") or {}
    if not isinstance(mood_profile, dict):
        raise ValueError("music_result mood_profile must be an object")

    claude = claude_client or AnthropicCoverClient()
    brief = normalize_cover_brief(
        claude.create_cover_brief(
            situation.strip(),
            normalized_emotions,
            mood_profile,
            recommendations,
            style,
        )
    )
    replicate = image_client or ReplicateImageClient()
    image_url = replicate.generate_image(brief["image_prompt"])
    local_path = None
    if output_path:
        local_path = replicate.download_image(image_url, output_path)

    return {
        "cover_style": style,
        "visual_summary": brief["visual_summary"],
        "image_prompt": brief["image_prompt"],
        "design_notes": brief["design_notes"],
        "cover": {
            "image_url": image_url,
            "local_path": local_path,
            "aspect_ratio": "1:1",
            "resolution": "1K",
            "output_format": "png",
        },
        "sources": {
            "claude_model": getattr(claude, "model", "injected-client"),
            "image_model": getattr(replicate, "model", "injected-client"),
            "playlist_track_count": len(recommendations),
        },
    }


def load_music_result(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            result = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read music result JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise ValueError("music result JSON must be an object")
    return result


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate one cover for a daily music-diary playlist."
    )
    parser.add_argument("--situation", required=True, help="Natural-language summary of the day.")
    parser.add_argument(
        "--emotion",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="Emotion score from 0.0 to 1.0. Repeat for multiple emotions.",
    )
    parser.add_argument(
        "--music-result",
        required=True,
        help="Path to the JSON output from mood_music_agent.py.",
    )
    parser.add_argument(
        "--style",
        required=True,
        help="anime, realistic, emotional, artistic, or a supported Korean alias.",
    )
    parser.add_argument("--output", default="playlist_cover.png", help="Local PNG output path.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        result = generate_playlist_cover(
            args.situation,
            parse_emotion_args(args.emotion),
            load_music_result(args.music_result),
            args.style,
            output_path=args.output,
        )
    except (
        ValueError,
        ConfigurationError,
        ModelOutputError,
        ApiRequestError,
        ImageGenerationError,
    ) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
