from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.image_emoji_pipeline import build_sticker_agent_inputs, run_image_emoji_pipeline


class FakeIntakeClient:
    model = "fake-intake"

    def analyze_logs(self, logs):
        return {
            "log_results": [
                {
                    "log_index": 1,
                    "selected_emotion_label": "편안한",
                    "mood_label": "초록빛 산책의 여유",
                    "situation": "행궁동 개천을 따라 느긋하게 산책했다.",
                    "image_context": "나무와 개천, 징검다리가 보이는 초록빛 풍경",
                    "emotions": {"joy": 0.62, "calm": 0.86},
                    "music_agent_input": {
                        "situation": "행궁동 개천을 따라 느긋하게 산책했다.",
                        "emotions": {"joy": 0.62, "calm": 0.86},
                    },
                    "cover_agent_input": {},
                }
            ]
        }


class ImageEmojiPipelineTests(unittest.TestCase):
    def test_build_sticker_inputs_uses_image_analysis(self):
        intake_result = {
            "log_results": [
                {
                    "log_index": 1,
                    "caption": "행궁동 나들이",
                    "mood_label": "초록빛 산책의 여유",
                    "situation": "행궁동 개천을 따라 느긋하게 산책했다.",
                    "image_context": "나무와 개천, 징검다리가 보이는 초록빛 풍경",
                    "emotions": {"joy": 0.62, "calm": 0.86},
                }
            ]
        }

        sticker_inputs = build_sticker_agent_inputs(intake_result)

        self.assertEqual(sticker_inputs[0]["id"], "1")
        self.assertEqual(sticker_inputs[0]["emotions"], {"joy": 0.62, "calm": 0.86})
        self.assertIn("행궁동 나들이", sticker_inputs[0]["text"])
        self.assertIn("개천을 따라", sticker_inputs[0]["text"])
        self.assertIn("징검다리", sticker_inputs[0]["text"])

    def test_run_pipeline_passes_analysis_to_sticker_agent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "input.jpg"
            image_path.write_bytes(b"test image fixture")
            expected_sticker_result = {
                "stickers": [{"log_id": "1", "local_path": "/tmp/sticker.png"}]
            }

            with patch(
                "agent.image_emoji_pipeline.generate_log_stickers",
                return_value=expected_sticker_result,
            ) as generate:
                result = run_image_emoji_pipeline(
                    image_path=image_path,
                    text="행궁동 나들이",
                    output_dir=Path(temp_dir) / "stickers",
                    intake_client=FakeIntakeClient(),
                    sticker_client=object(),
                    image_client=object(),
                )

        sticker_inputs = generate.call_args.args[0]
        self.assertIn("징검다리", sticker_inputs[0]["text"])
        self.assertEqual(sticker_inputs[0]["emotions"]["calm"], 0.86)
        self.assertEqual(result["sticker_agent_inputs"], sticker_inputs)
        self.assertEqual(result["sticker_result"], expected_sticker_result)


if __name__ == "__main__":
    unittest.main()
