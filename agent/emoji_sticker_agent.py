"""Generate one style-consistent emoji sticker for each daily log."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
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
DEFAULT_STYLE_REFERENCE = (
    Path(__file__).resolve().parent / "assets" / "emoji_sticker_style_reference.png"
)
MAX_LOGS = 20


class ConfigurationError(RuntimeError):
    """Raised when a required API credential is missing."""


class ModelOutputError(RuntimeError):
    """Raised when Claude returns unusable sticker concepts."""


class ApiRequestError(RuntimeError):
    """Raised when an external API request fails."""


class RateLimitError(ApiRequestError):
    """Raised when an API asks the client to retry after a delay."""

    def __init__(self, message: str, retry_after: float = 10.0) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ImageGenerationError(RuntimeError):
    """Raised when Replicate cannot generate or return a sticker."""


def normalize_logs(raw_logs: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_logs, list) or not raw_logs:
        raise ValueError("logs must be a non-empty list")
    if len(raw_logs) > MAX_LOGS:
        raise ValueError(f"logs must contain at most {MAX_LOGS} items")

    logs: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw_log in enumerate(raw_logs, start=1):
        if isinstance(raw_log, str):
            log_id = str(index)
            text = raw_log.strip()
            emotions: dict[str, Any] = {}
        elif isinstance(raw_log, dict):
            log_id = str(raw_log.get("id") or index).strip()
            text = str(raw_log.get("text") or raw_log.get("log") or "").strip()
            raw_emotions = raw_log.get("emotions") or {}
            if not isinstance(raw_emotions, dict):
                raise ValueError(f"log '{log_id}' emotions must be an object")
            emotions = raw_emotions
        else:
            raise ValueError(f"log {index} must be a string or object")

        if not text:
            raise ValueError(f"log '{log_id}' text must be non-empty")
        if not log_id:
            raise ValueError("log ids must be non-empty")
        if log_id in seen_ids:
            raise ValueError(f"duplicate log id: {log_id}")
        seen_ids.add(log_id)
        logs.append({"id": log_id, "text": text, "emotions": emotions})
    return logs


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


def normalize_sticker_briefs(
    raw_briefs: Any,
    logs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if isinstance(raw_briefs, list):
        raw_stickers = raw_briefs
    elif isinstance(raw_briefs, dict) and isinstance(raw_briefs.get("stickers"), list):
        raw_stickers = raw_briefs["stickers"]
    else:
        raise ModelOutputError("Claude response must include a stickers list")

    by_id: dict[str, dict[str, Any]] = {}
    for raw_brief in raw_stickers:
        if not isinstance(raw_brief, dict):
            continue
        log_id = str(raw_brief.get("log_id") or "").strip()
        concept = str(raw_brief.get("concept") or "").strip()
        symbol = str(raw_brief.get("symbol") or "").strip()
        emotion_label = str(raw_brief.get("emotion_label") or "").strip()
        eye_shape = str(raw_brief.get("eye_shape") or "").strip()
        mouth_shape = str(raw_brief.get("mouth_shape") or "").strip()
        accent = str(raw_brief.get("accent") or "none").strip()
        raw_intensity = raw_brief.get("emotion_intensity")
        if not isinstance(raw_intensity, int | float) or not 0.0 <= float(raw_intensity) <= 1.0:
            raise ModelOutputError(f"invalid emotion_intensity for log '{log_id}'")
        emotion_intensity = float(raw_intensity)
        color_rationale = str(raw_brief.get("color_rationale") or "").strip()
        primary_color = _normalize_palette_color(raw_brief.get("primary_color"))
        secondary_color = _normalize_palette_color(raw_brief.get("secondary_color"))
        if primary_color == secondary_color:
            raise ModelOutputError(f"sticker colors must differ for log '{log_id}'")
        if log_id and concept and symbol and emotion_label and eye_shape and mouth_shape and color_rationale:
            by_id[log_id] = {
                "log_id": log_id,
                "concept": concept,
                "symbol": symbol,
                "emotion_label": emotion_label,
                "emotion_intensity": emotion_intensity,
                "eye_shape": eye_shape,
                "mouth_shape": mouth_shape,
                "accent": accent,
                "primary_color": primary_color,
                "secondary_color": secondary_color,
                "color_rationale": color_rationale,
            }

    ordered: list[dict[str, Any]] = []
    for log in logs:
        brief = by_id.get(log["id"])
        if not brief:
            raise ModelOutputError(f"Claude returned no usable sticker brief for log '{log['id']}'")
        ordered.append(brief)
    return ordered


def _normalize_palette_color(raw_color: Any) -> str:
    color = str(raw_color or "").strip().upper()
    if not re.fullmatch(r"#[0-9A-F]{6}", color):
        raise ModelOutputError(f"invalid sticker color: {raw_color}")
    red, green, blue = _hex_to_rgb(color)
    average = (red + green + blue) / 3
    if average < 120:
        lift = round(120 - average)
        red, green, blue = (min(channel + lift, 255) for channel in (red, green, blue))
    if min(red, green, blue) > 225:
        reduction = min(red, green, blue) - 215
        red, green, blue = (max(channel - reduction, 0) for channel in (red, green, blue))
    return f"#{red:02X}{green:02X}{blue:02X}"


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))


def _rgb_to_hex(color: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in color)


def derive_shading_colors(primary_color: str) -> dict[str, str]:
    red, green, blue = _hex_to_rgb(primary_color)
    highlight = tuple(
        round(channel * 0.72 + 255 * 0.28)
        for channel in (red, green, blue)
    )
    shadow = tuple(round(channel * 0.72) for channel in (red, green, blue))
    return {
        "highlight_color": _rgb_to_hex(highlight),
        "shadow_color": _rgb_to_hex(shadow),
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


class AnthropicStickerClient:
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

    def create_sticker_briefs(self, logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        payload = {
            "model": self.model,
            "max_tokens": 1800,
            "temperature": 0.4,
            "system": (
                "You turn daily-life logs into simple, immediately recognizable emoji-sticker "
                "concepts. Create exactly one distinct concept per log. Return only one JSON object."
            ),
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Choose one concrete visual symbol for each log. The symbol should capture the "
                        "specific event before the general emotion: for example, an umbrella for a rainy "
                        "walk, a cup for a cafe visit, or a shoe for a run. Give that object a minimal "
                        "emoji face whose expression accurately reflects the log. Do not sanitize negative, "
                        "mixed, tired, anxious, angry, or neutral emotions into happiness. Choose an explicit "
                        "dominant emotion, intensity from 0.0 to 1.0, eye shape, mouth shape, and at most one "
                        "small emotion accent. Use downturned or flat mouths, uneven or half-closed eyes, angled "
                        "brows, a single tear, or a sweat drop when appropriate; use a smile only when the log "
                        "is genuinely joyful. Avoid abstract scenes, multiple "
                        "objects, text, brands, copyrighted characters, and music-note symbols.\n\n"
                        "Choose two distinct flat colors that suit the event and emotion. Colors may vary "
                        "widely between logs: rain can use blues, a cafe can use warm browns or oranges, "
                        "exercise can use greens, and celebration can use vivid pinks or reds. Keep both "
                        "colors saturated or mid-tone enough for a black face to remain readable; never "
                        "choose near-white or near-black. Return both as six-digit hex colors and briefly "
                        "explain the choice in Korean.\n\n"
                        f"Logs JSON: {json.dumps(logs, ensure_ascii=False, sort_keys=True)}\n\n"
                        "Return exactly this shape: {\"stickers\":[{\"log_id\":\"...\","
                        "\"concept\":\"short Korean description\",\"symbol\":\"specific object in English\","
                        "\"emotion_label\":\"dominant emotion in Korean\",\"emotion_intensity\":0.0,"
                        "\"eye_shape\":\"specific simple eye shape in English\","
                        "\"mouth_shape\":\"specific simple mouth shape in English\","
                        "\"accent\":\"one small black emotion accent in English or none\","
                        "\"primary_color\":\"#RRGGBB\",\"secondary_color\":\"#RRGGBB\","
                        "\"color_rationale\":\"short Korean explanation\"}]}"
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
        return normalize_sticker_briefs(extract_json_object("\n".join(text_parts)), logs)


def build_sticker_prompt(brief: dict[str, Any]) -> str:
    shading = derive_shading_colors(brief["primary_color"])
    return (
        "Use the provided image only as a visual style reference, never as a shape or subject reference. "
        f"Create a brand-new emoji sticker representing {brief['concept']}, using the clear silhouette "
        f"of one {brief['symbol']}. The face must visibly communicate {brief['emotion_label']} at "
        f"{brief['emotion_intensity']:.2f} emotional intensity. Use {brief['eye_shape']} for the eyes and "
        f"{brief['mouth_shape']} for the mouth, placed naturally on the object's main surface. Add "
        f"{brief['accent']} as the only optional emotion accent. Do not default to a smile when the specified "
        "mouth or emotion is neutral or negative. Draw every facial feature as a bold, minimal black vector "
        "shape. Match the reference's "
        "flat 2D vector-like drawing language: a rounded organic silhouette with no outer outline, an exact "
        f"{brief['primary_color']} main fill, one crisp {brief['secondary_color']} secondary color region, "
        f"one flat {shading['highlight_color']} highlight region on the upper-left-facing surface, and one "
        f"flat {shading['shadow_color']} shadow region on the lower-right-facing surface. Use a consistent "
        "top-left light direction and crisp cel-shading boundaries. Keep the highlight and shadow broad and "
        "simple, never glossy or realistic. Use smooth clean edges and "
        "bold minimal geometry. Keep every color region completely flat, with blank graphic surfaces and "
        "no letters, numbers, logos, gradients, lighting effects, shadows, texture, or 3D volume. The new "
        "silhouette is based only on the log-specific object and is wholly distinct from the musical-note "
        "shape in the reference. Place one large centered sticker on a square canvas with generous padding. "
        "The entire area outside the sticker is one perfectly uniform pure white (#FFFFFF) field, edge to edge. "
        "Render the background as actual solid white pixels, never as a transparency checkerboard or pattern."
    )


def reference_image_uri(value: str | os.PathLike[str]) -> str:
    raw_value = str(value)
    if raw_value.startswith(("https://", "http://", "data:")):
        return raw_value
    path = Path(raw_value).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"style reference image does not exist: {path}")
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def build_replicate_input(image_prompt: str, style_reference_uri: str) -> dict[str, Any]:
    if not image_prompt or not image_prompt.strip():
        raise ValueError("image_prompt must be non-empty")
    if not style_reference_uri:
        raise ValueError("style_reference_uri must be non-empty")
    return {
        "prompt": image_prompt.strip(),
        "image_input": [style_reference_uri],
        "aspect_ratio": "1:1",
        "resolution": "1K",
        "output_format": "png",
        "google_search": False,
        "image_search": False,
    }


def make_white_background_transparent(
    image_path: str | os.PathLike[str],
    fade_start: int = 225,
    transparent_at: int = 245,
) -> str:
    try:
        from PIL import Image
    except ImportError as exc:
        raise ConfigurationError("Pillow is required for transparent sticker output") from exc

    path = Path(image_path).expanduser().resolve()
    with Image.open(path) as source:
        image = source.convert("RGBA")
    width, height = image.size
    pixels = list(
        image.get_flattened_data()
        if hasattr(image, "get_flattened_data")
        else image.getdata()
    )

    pending = [
        index
        for row in range(height)
        for index in (row * width, row * width + width - 1)
    ]
    pending.extend(range(width))
    pending.extend(range((height - 1) * width, height * width))

    background: set[int] = set()
    while pending:
        index = pending.pop()
        if index in background:
            continue
        red, green, blue, _alpha = pixels[index]
        if min(red, green, blue) <= fade_start:
            continue
        background.add(index)

        x = index % width
        y = index // width
        for neighbor_y in range(max(0, y - 1), min(height, y + 2)):
            row_start = neighbor_y * width
            for neighbor_x in range(max(0, x - 1), min(width, x + 2)):
                neighbor = row_start + neighbor_x
                if neighbor not in background:
                    pending.append(neighbor)

    converted: list[tuple[int, int, int, int]] = []
    for index, (red, green, blue, _alpha) in enumerate(pixels):
        if index not in background:
            converted.append((red, green, blue, 255))
            continue
        darkest_channel = min(red, green, blue)
        if darkest_channel >= transparent_at:
            alpha = 0
        elif darkest_channel > fade_start:
            alpha = round(255 * (transparent_at - darkest_channel) / (transparent_at - fade_start))
        else:
            alpha = 255
        converted.append((red, green, blue, alpha))
    image.putdata(converted)
    image.save(path, format="PNG")
    return str(path)


def apply_sticker_palette(
    image_path: str | os.PathLike[str],
    primary_color: str,
    secondary_color: str,
    highlight_color: str | None = None,
    shadow_color: str | None = None,
) -> str:
    try:
        from PIL import Image
    except ImportError as exc:
        raise ConfigurationError("Pillow is required for sticker palette processing") from exc

    shading = derive_shading_colors(primary_color)
    palette = [
        (0, 0, 0),
        _hex_to_rgb(primary_color),
        _hex_to_rgb(secondary_color),
        _hex_to_rgb(highlight_color or shading["highlight_color"]),
        _hex_to_rgb(shadow_color or shading["shadow_color"]),
    ]

    path = Path(image_path).expanduser().resolve()
    with Image.open(path) as source:
        image = source.convert("RGBA")
    pixels = (
        image.get_flattened_data()
        if hasattr(image, "get_flattened_data")
        else image.getdata()
    )
    flattened: list[tuple[int, int, int, int]] = []
    for red, green, blue, alpha in pixels:
        if alpha == 0:
            flattened.append((red, green, blue, 0))
            continue
        nearest = min(
            palette,
            key=lambda color: (
                (red - color[0]) ** 2
                + (green - color[1]) ** 2
                + (blue - color[2]) ** 2
            ),
        )
        flattened.append((*nearest, alpha))
    image.putdata(flattened)
    image.save(path, format="PNG")
    return str(path)


class ReplicateStickerClient:
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

    def generate_image(self, image_prompt: str, style_reference_uri: str) -> str:
        request = urllib.request.Request(
            REPLICATE_PREDICTIONS_URL,
            data=json.dumps(
                {"input": build_replicate_input(image_prompt, style_reference_uri)}
            ).encode("utf-8"),
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

    def download_image(self, image_url: str, output_path: str | os.PathLike[str]) -> str:
        path = Path(output_path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(image_url, headers={"user-agent": "EmojiStickerAgent/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=self.request_timeout) as response:
                path.write_bytes(response.read())
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise ImageGenerationError(f"Could not download generated sticker: {exc}") from exc
        return str(path)


def generate_log_stickers(
    raw_logs: list[Any],
    *,
    style_reference: str | os.PathLike[str] = DEFAULT_STYLE_REFERENCE,
    output_dir: str | os.PathLike[str] | None = "generated_stickers",
    claude_client: Any | None = None,
    image_client: Any | None = None,
) -> dict[str, Any]:
    logs = normalize_logs(raw_logs)
    reference_uri = reference_image_uri(style_reference)
    claude = claude_client or AnthropicStickerClient()
    briefs = normalize_sticker_briefs(claude.create_sticker_briefs(logs), logs)
    replicate = image_client or ReplicateStickerClient()

    output_path = Path(output_dir).expanduser().resolve() if output_dir else None
    stickers: list[dict[str, Any]] = []
    for index, (log, brief) in enumerate(zip(logs, briefs, strict=True), start=1):
        shading = derive_shading_colors(brief["primary_color"])
        image_prompt = build_sticker_prompt(brief)
        image_url = replicate.generate_image(image_prompt, reference_uri)
        local_path = None
        if output_path:
            local_path = replicate.download_image(
                image_url,
                output_path / f"sticker_{index:02d}.png",
            )
            local_path = make_white_background_transparent(local_path)
            local_path = apply_sticker_palette(
                local_path,
                brief["primary_color"],
                brief["secondary_color"],
                shading["highlight_color"],
                shading["shadow_color"],
            )
        stickers.append(
            {
                "log_id": log["id"],
                "log_text": log["text"],
                "concept": brief["concept"],
                "symbol": brief["symbol"],
                "emotion_label": brief["emotion_label"],
                "emotion_intensity": brief["emotion_intensity"],
                "eye_shape": brief["eye_shape"],
                "mouth_shape": brief["mouth_shape"],
                "accent": brief["accent"],
                "primary_color": brief["primary_color"],
                "secondary_color": brief["secondary_color"],
                "highlight_color": shading["highlight_color"],
                "shadow_color": shading["shadow_color"],
                "color_rationale": brief["color_rationale"],
                "image_prompt": image_prompt,
                "image_url": image_url,
                "local_path": local_path,
            }
        )

    return {
        "stickers": stickers,
        "style_reference": str(style_reference),
        "sources": {
            "claude_model": getattr(claude, "model", "injected-client"),
            "image_model": getattr(replicate, "model", "injected-client"),
            "sticker_count": len(stickers),
        },
    }


def load_logs_json(path: str) -> list[Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read logs JSON: {exc}") from exc
    if isinstance(parsed, dict):
        parsed = parsed.get("logs")
    if not isinstance(parsed, list):
        raise ValueError("logs JSON must be a list or an object with a logs list")
    return parsed


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate one style-consistent emoji sticker for each daily log."
    )
    parser.add_argument(
        "--log",
        action="append",
        default=[],
        help="One natural-language log. Repeat for multiple logs.",
    )
    parser.add_argument("--logs-json", help="Optional path to a JSON list of structured logs.")
    parser.add_argument(
        "--style-reference",
        default=str(DEFAULT_STYLE_REFERENCE),
        help="Local path, URL, or data URL for the visual style reference.",
    )
    parser.add_argument("--output-dir", default="generated_stickers")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        logs: list[Any] = list(args.log)
        if args.logs_json:
            logs.extend(load_logs_json(args.logs_json))
        result = generate_log_stickers(
            logs,
            style_reference=args.style_reference,
            output_dir=args.output_dir,
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
