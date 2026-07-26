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
ASSET_DIR = Path(__file__).resolve().parent / "assets"
DEFAULT_STYLE_VARIANT = "soft"
STYLE_VARIANTS = ("soft", "hip")
STYLE_REFERENCES = {
    "soft": ASSET_DIR / "emoji_sticker_style_reference_soft.png",
    "hip": ASSET_DIR / "emoji_sticker_style_reference_hip.png",
}
STYLE_OUTLINE_COLORS = {
    "soft": "#52463D",
    "hip": "#4A4052",
}
DEFAULT_STYLE_REFERENCE = STYLE_REFERENCES[DEFAULT_STYLE_VARIANT]
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
        if any(
            token in eye_shape.lower()
            for token in ("wide", "staring", "bulging", "sclera", "eye whites", "circle eyes")
        ):
            eye_shape = "tiny gently tilted dot eyes"
        if any(
            token in mouth_shape.lower()
            for token in ("open", "o-shaped", "o shaped", "screaming", "teeth", "fang", "gaping")
        ):
            mouth_shape = "tiny closed softly curved mouth"
        accent = str(raw_brief.get("accent") or "none").strip()
        if any(
            token in accent.lower()
            for token in (
                "exclamation",
                "question mark",
                "z mark",
                "zzz",
                "letter",
                "number",
                "punctuation",
                "word",
                "text",
            )
        ):
            accent = "none"
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
                "You turn daily-life logs into cute, friendly hand-drawn illustration-sticker concepts "
                "for a scrapbook or diary album. Keep each concept simple, gentle, and immediately "
                "recognizable. Create exactly one distinct concept per log. Return only one JSON object."
            ),
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Choose one concrete central visual symbol for each log. Prefer the specific event "
                        "over a generic emotion: for example, an umbrella for a rainy walk, a cup for a cafe "
                        "visit, or a running shoe for a run. The symbol may be an object, plant, animal, or "
                        "simple mascot, but do not default every log to a cute animal. Add a minimal face only "
                        "when it clearly helps communicate the emotion; otherwise return 'none' for both eye "
                        "shape and mouth shape. "
                        "Do not sanitize negative, mixed, tired, anxious, angry, or neutral emotions into "
                        "happiness, but express them in a soft, endearing way rather than an intense or "
                        "frightening way. "
                        "Choose an explicit dominant emotion, intensity from 0.0 to 1.0, eye shape, mouth "
                        "shape, and at most one small emotion accent. If a face is used, keep it tiny and "
                        "friendly with dot eyes or short curved eyes and a small closed mouth. For tired, "
                        "worried, angry, or surprised emotions, use gently drooping or tilted features instead "
                        "of wide staring eyes or a screaming mouth. Never use visible eye whites, bulging eyes, "
                        "large open mouths, exposed teeth, sharply furrowed brows, sinister expressions, or "
                        "horror imagery. Emotion accents must be pictorial shapes such as a raindrop, sparkle, "
                        "or sweat drop; never use alarm punctuation, question punctuation, sleep-letter glyphs, "
                        "letters, numbers, or words as accents. Avoid complex scenes, multiple focal objects, text, brands, "
                        "copyrighted characters, and decorative music-note symbols unless the log itself is "
                        "explicitly about music.\n\n"
                        "Choose two distinct flat colors that suit the event and emotion. Colors may vary "
                        "widely between logs: rain can use blues, a cafe can use warm browns or oranges, "
                        "exercise can use greens, and celebration can use vivid pinks or reds. Keep both "
                        "colors saturated or mid-tone enough for dark ink details to remain readable; never "
                        "choose near-white or near-black. Return both as six-digit hex colors and briefly "
                        "explain the choice in Korean.\n\n"
                        f"Logs JSON: {json.dumps(logs, ensure_ascii=False, sort_keys=True)}\n\n"
                        "Return exactly this shape: {\"stickers\":[{\"log_id\":\"...\","
                        "\"concept\":\"short Korean description\","
                        "\"symbol\":\"specific central object or simple mascot in English\","
                        "\"emotion_label\":\"dominant emotion in Korean\",\"emotion_intensity\":0.0,"
                        "\"eye_shape\":\"specific simple eye shape in English or none\","
                        "\"mouth_shape\":\"specific simple mouth shape in English or none\","
                        "\"accent\":\"one small pictorial emotion accent in English or none; never text or punctuation\","
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


def build_sticker_prompt(
    brief: dict[str, Any],
    style_variant: str = DEFAULT_STYLE_VARIANT,
) -> str:
    if style_variant not in STYLE_VARIANTS:
        raise ValueError(f"unsupported style variant: {style_variant}")
    has_face = (
        str(brief["eye_shape"]).strip().lower() != "none"
        and str(brief["mouth_shape"]).strip().lower() != "none"
    )
    if has_face:
        face_instruction = (
            f"Use {brief['eye_shape']} for the eyes and {brief['mouth_shape']} for the mouth. "
            "Keep the facial marks tiny, softly curved, friendly, and subordinate to the main symbol. "
            "Use no visible eye whites, bulging or staring eyes, large open mouth, exposed teeth, or "
            "aggressive brows. "
            "Do not default to a smile when the specified mouth or emotion is neutral or negative. "
        )
    else:
        face_instruction = (
            "Do not add a face, eyes, or mouth; communicate the mood through the symbol's shape, "
            "pose, and color only. "
        )
    if style_variant == "soft":
        style_instruction = (
            "Match the reference's cute hand-drawn sticker illustration language for a scrapbook or diary "
            "album: a compact, soft, rounded silhouette; simplified hand-drawn geometry; gently wobbly "
            "curves; thin-to-medium warm-charcoal or deep colored-pencil outlines; and cozy matte "
            "gouache-like color blocks. "
            f"Use an exact {brief['primary_color']} main color and one clear "
            f"{brief['secondary_color']} secondary color, plus warm charcoal and white only. Add only a "
            "light paper-grain or colored-pencil texture inside the colored shapes, with clean continuous "
            "fills and no harsh scratches, distressed holes, dirty speckles, or grunge. "
            "The result should feel warm, playful, approachable, and cute without looking babyish. "
        )
    else:
        style_instruction = (
            "Match the reference's hip indie-zine, record-shop, and street-culture sticker language: a bold "
            "compact silhouette with rounded corners; playful asymmetry; medium-weight muted deep-plum "
            "contours; flat two-color risograph or screen-print layers; small sparse halftone clusters; and a "
            "controlled slightly misregistered color edge. Keep the geometry gently softened and leave a "
            "little breathing room between details so the image feels friendly at first glance. "
            f"Use an exact {brief['primary_color']} main color and one punchy "
            f"{brief['secondary_color']} secondary color, plus muted deep-plum ink and white only. Keep the "
            "texture intentional and graphic, with crisp shapes and restrained print grain rather than dirty "
            "grunge or damaged surfaces. Avoid heavy all-around black contours, sharp comic-burst geometry, "
            "or abrupt black-white contrast. The result should feel witty, current, collectible, and "
            "effortlessly cool, but with a slightly softer and more approachable finish, without becoming "
            "aggressive, scary, luxury, corporate, or childish. "
        )
    return (
        "Use the provided image only as a visual style reference, never as a shape or subject reference. "
        f"Create a brand-new illustrated die-cut sticker representing {brief['concept']} with one bold, "
        f"log-specific central symbol: {brief['symbol']}. It must communicate "
        f"{brief['emotion_label']} at {brief['emotion_intensity']:.2f} emotional intensity. "
        f"{face_instruction}Add {brief['accent']} as the only optional small accent. "
        "Emotion accents must remain purely pictorial; do not render alarm punctuation, question punctuation, "
        "sleep-letter glyphs, letters, numbers, or words. "
        f"{style_instruction}Keep the symbol crisp and immediately readable at emoji size. "
        "This is one standalone sticker, never an "
        "album cover, poster, label, package, or multi-object scene. Surround the complete silhouette with "
        "one smooth opaque white die-cut sticker border and a very soft thin pale-gray separation edge so the "
        "border remains distinct from the white canvas. Use no text, letters, numbers, punctuation, captions, "
        "speech bubbles, logos, brands, signatures, or watermarks anywhere. Do not add typography-like marks, "
        "fake labels, interface symbols, barcodes, or decorative writing. Avoid glossy rendering, gradients, "
        "realistic lighting, smooth corporate vector polish, 3D volume, photorealistic texture, black-heavy "
        "artwork, sharp threatening shapes, grotesque distortion, horror, or edgy band-merch styling. "
        "Place one large centered sticker on a square canvas with generous padding. "
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
    outline_color: str = STYLE_OUTLINE_COLORS[DEFAULT_STYLE_VARIANT],
) -> str:
    try:
        from PIL import Image
    except ImportError as exc:
        raise ConfigurationError("Pillow is required for sticker palette processing") from exc

    shading = derive_shading_colors(primary_color)
    palette = [
        _hex_to_rgb(outline_color),
        (210, 210, 210),
        (255, 255, 255),
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
    style_variant: str = DEFAULT_STYLE_VARIANT,
    style_reference: str | os.PathLike[str] | None = None,
    output_dir: str | os.PathLike[str] | None = "generated_stickers",
    claude_client: Any | None = None,
    image_client: Any | None = None,
) -> dict[str, Any]:
    if style_variant not in STYLE_VARIANTS:
        raise ValueError(f"unsupported style variant: {style_variant}")
    logs = normalize_logs(raw_logs)
    resolved_style_reference = style_reference or STYLE_REFERENCES[style_variant]
    reference_uri = reference_image_uri(resolved_style_reference)
    claude = claude_client or AnthropicStickerClient()
    briefs = normalize_sticker_briefs(claude.create_sticker_briefs(logs), logs)
    replicate = image_client or ReplicateStickerClient()

    output_path = Path(output_dir).expanduser().resolve() if output_dir else None
    stickers: list[dict[str, Any]] = []
    for index, (log, brief) in enumerate(zip(logs, briefs, strict=True), start=1):
        shading = derive_shading_colors(brief["primary_color"])
        image_prompt = build_sticker_prompt(brief, style_variant=style_variant)
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
                STYLE_OUTLINE_COLORS[style_variant],
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
        "style_variant": style_variant,
        "style_reference": str(resolved_style_reference),
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
        "--style",
        default=DEFAULT_STYLE_VARIANT,
        choices=STYLE_VARIANTS,
        help="Built-in sticker style variant.",
    )
    parser.add_argument(
        "--style-reference",
        default="",
        help="Optional local path, URL, or data URL overriding the selected style's reference.",
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
            style_variant=args.style,
            style_reference=args.style_reference or None,
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
