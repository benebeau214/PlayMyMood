"""Connect photo analysis to emoji sticker generation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from agent.emoji_sticker_agent import (
    DEFAULT_STYLE_REFERENCE,
    ApiRequestError,
    ConfigurationError as StickerConfigurationError,
    ImageGenerationError,
    ModelOutputError as StickerModelOutputError,
    generate_log_stickers,
)
from agent.mood_intake_agent import (
    CUSTOM_EMOTION_LABELS,
    ConfigurationError as IntakeConfigurationError,
    EmotionLog,
    ModelOutputError as IntakeModelOutputError,
    analyze_daily_logs,
)


def build_sticker_agent_inputs(intake_result: dict[str, Any]) -> list[dict[str, Any]]:
    """Adapt normalized intake results to the emoji agent's log contract."""
    raw_results = intake_result.get("log_results")
    if not isinstance(raw_results, list) or not raw_results:
        raise ValueError("intake result must include at least one log_result")

    sticker_inputs: list[dict[str, Any]] = []
    for index, result in enumerate(raw_results, start=1):
        if not isinstance(result, dict):
            raise ValueError(f"intake log_result at index {index} must be an object")

        text_parts = [
            ("사용자 기록", result.get("caption")),
            ("사진 분석", result.get("image_context")),
            ("상황 분석", result.get("situation")),
            ("감정 분석", result.get("mood_label")),
            ("선택한 감정", result.get("selected_emotion_label")),
        ]
        text = "\n".join(
            f"{label}: {str(value).strip()}"
            for label, value in text_parts
            if str(value or "").strip()
        )
        if not text:
            raise ValueError(f"intake log_result at index {index} has no usable text")

        emotions = result.get("emotions")
        if not isinstance(emotions, dict):
            emotions = {}
        sticker_inputs.append(
            {
                "id": str(result.get("log_index") or index),
                "text": text,
                "emotions": emotions,
            }
        )
    return sticker_inputs


def run_image_emoji_pipeline(
    *,
    image_path: str | os.PathLike[str],
    text: str,
    selected_emotion_label: str = "",
    style_reference: str | os.PathLike[str] = DEFAULT_STYLE_REFERENCE,
    output_dir: str | os.PathLike[str] = "generated_stickers",
    intake_client: Any | None = None,
    sticker_client: Any | None = None,
    image_client: Any | None = None,
) -> dict[str, Any]:
    """Analyze one image log, then generate one sticker from that analysis."""
    resolved_image = Path(image_path).expanduser().resolve()
    if not resolved_image.is_file():
        raise ValueError(f"image does not exist: {resolved_image}")

    normalized_text = text.strip()
    if not normalized_text:
        raise ValueError("text must be non-empty")
    if selected_emotion_label and selected_emotion_label not in CUSTOM_EMOTION_LABELS:
        raise ValueError(f"unsupported emotion label: {selected_emotion_label}")

    intake_result = analyze_daily_logs(
        [
            EmotionLog(
                caption=normalized_text,
                emoji=selected_emotion_label,
                image_path=str(resolved_image),
            )
        ],
        client=intake_client,
    )
    sticker_inputs = build_sticker_agent_inputs(intake_result)
    sticker_result = generate_log_stickers(
        sticker_inputs,
        style_reference=style_reference,
        output_dir=output_dir,
        claude_client=sticker_client,
        image_client=image_client,
    )
    return {
        "input": {
            "image_path": str(resolved_image),
            "text": normalized_text,
            "selected_emotion_label": selected_emotion_label,
        },
        "intake_result": intake_result,
        "sticker_agent_inputs": sticker_inputs,
        "sticker_result": sticker_result,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze one photo and generate one emoji sticker from the analysis."
    )
    parser.add_argument("--image", required=True, help="Path to the photo to analyze.")
    parser.add_argument("--text", required=True, help="User log text/caption.")
    parser.add_argument(
        "--emoji",
        default="",
        choices=("", *CUSTOM_EMOTION_LABELS),
        help="Optional user-selected emotion label.",
    )
    parser.add_argument(
        "--style-reference",
        default=str(DEFAULT_STYLE_REFERENCE),
        help="Style reference passed to the emoji sticker agent.",
    )
    parser.add_argument("--output-dir", default="generated_stickers")
    parser.add_argument("--output-json", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        result = run_image_emoji_pipeline(
            image_path=args.image,
            text=args.text,
            selected_emotion_label=args.emoji,
            style_reference=args.style_reference,
            output_dir=args.output_dir,
        )
        output_text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output_json:
            output_path = Path(args.output_json).expanduser().resolve()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(output_text, encoding="utf-8")
        print(output_text)
        return 0
    except (
        ValueError,
        IntakeConfigurationError,
        IntakeModelOutputError,
        StickerConfigurationError,
        StickerModelOutputError,
        ApiRequestError,
        ImageGenerationError,
    ) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
