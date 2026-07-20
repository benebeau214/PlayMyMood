import tempfile
import unittest
from pathlib import Path

from agent import emoji_sticker_agent as agent


class LogNormalizationTests(unittest.TestCase):
    def test_accepts_plain_and_structured_logs(self):
        logs = agent.normalize_logs(
            [
                "퇴근길에 비를 맞았다",
                {"id": "coffee", "text": "친구와 카페에서 오래 이야기했다", "emotions": {"joy": 0.8}},
            ]
        )
        self.assertEqual(logs[0]["id"], "1")
        self.assertEqual(logs[1]["id"], "coffee")
        self.assertEqual(logs[1]["emotions"], {"joy": 0.8})

    def test_rejects_duplicate_log_ids(self):
        with self.assertRaisesRegex(ValueError, "duplicate log id"):
            agent.normalize_logs([{"id": "same", "text": "a"}, {"id": "same", "text": "b"}])


class StyleAndPromptTests(unittest.TestCase):
    def test_shading_colors_are_derived_from_primary_color(self):
        shading = agent.derive_shading_colors("#4A90E2")
        self.assertEqual(shading["highlight_color"], "#7DAFEA")
        self.assertEqual(shading["shadow_color"], "#3568A3")

    def test_dark_emotional_color_is_lifted_instead_of_rejected(self):
        self.assertEqual(agent._normalize_palette_color("#3D3D3D"), "#787878")

    def test_reference_image_is_encoded_as_data_url(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference.png"
            path.write_bytes(b"png-test")
            uri = agent.reference_image_uri(path)
        self.assertTrue(uri.startswith("data:image/png;base64,"))

    def test_prompt_uses_reference_for_style_not_shape(self):
        prompt = agent.build_sticker_prompt(
            {
                "concept": "비 오는 퇴근길",
                "symbol": "umbrella",
                "emotion_label": "피로와 안도",
                "emotion_intensity": 0.7,
                "eye_shape": "half-closed drooping eyes",
                "mouth_shape": "a short flat mouth",
                "accent": "one small sweat drop",
                "primary_color": "#4A90E2",
                "secondary_color": "#78D5E3",
            }
        )
        self.assertIn("only as a visual style reference", prompt)
        self.assertIn("one umbrella", prompt)
        self.assertIn("distinct from the musical-note shape", prompt)
        self.assertIn("half-closed drooping eyes", prompt)
        self.assertIn("a short flat mouth", prompt)
        self.assertIn("Do not default to a smile", prompt)
        self.assertIn("top-left light direction", prompt)
        self.assertIn("crisp cel-shading boundaries", prompt)

    def test_replicate_input_uses_reference_and_square_1k_png(self):
        payload = agent.build_replicate_input("A sticker", "data:image/png;base64,abc")
        self.assertEqual(payload["image_input"], ["data:image/png;base64,abc"])
        self.assertEqual(payload["aspect_ratio"], "1:1")
        self.assertEqual(payload["resolution"], "1K")
        self.assertEqual(payload["output_format"], "png")

    def test_white_background_is_converted_to_real_alpha(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sticker.png"
            image = Image.new("RGB", (2, 1))
            image.putdata([(255, 255, 255), (255, 226, 100)])
            image.save(path)
            agent.make_white_background_transparent(path)
            with Image.open(path) as converted:
                rgba = converted.convert("RGBA")
                pixel_data = (
                    rgba.get_flattened_data()
                    if hasattr(rgba, "get_flattened_data")
                    else rgba.getdata()
                )
                pixels = list(pixel_data)

        self.assertEqual(pixels[0][3], 0)
        self.assertEqual(pixels[1][3], 255)

    def test_generated_colors_are_flattened_to_selected_palette(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "output.png"
            output = Image.new("RGBA", (3, 1))
            output.putdata([(10, 10, 10, 255), (80, 140, 220, 255), (110, 210, 225, 255)])
            output.save(output_path)
            agent.apply_sticker_palette(output_path, "#4A90E2", "#78D5E3")
            with Image.open(output_path) as converted:
                colors = set(converted.convert("RGBA").get_flattened_data())

        self.assertEqual(
            colors,
            {(0, 0, 0, 255), (74, 144, 226, 255), (120, 213, 227, 255)},
        )


class EndToEndTests(unittest.TestCase):
    def test_generates_one_sticker_per_log_with_injected_clients(self):
        class FakeClaude:
            model = "claude-haiku-4-5"

            def create_sticker_briefs(self, logs):
                return [
                    {
                        "log_id": logs[0]["id"],
                        "concept": "비 오는 퇴근길",
                        "symbol": "umbrella",
                        "emotion_label": "피로와 안도",
                        "emotion_intensity": 0.7,
                        "eye_shape": "half-closed drooping eyes",
                        "mouth_shape": "a short flat mouth",
                        "accent": "one small sweat drop",
                        "primary_color": "#4A90E2",
                        "secondary_color": "#78D5E3",
                        "color_rationale": "비 오는 저녁의 시원하고 차분한 색",
                    },
                    {
                        "log_id": logs[1]["id"],
                        "concept": "친구와 마신 커피",
                        "symbol": "coffee mug",
                        "emotion_label": "기쁨",
                        "emotion_intensity": 0.8,
                        "eye_shape": "happy closed crescent eyes",
                        "mouth_shape": "a broad upturned mouth",
                        "accent": "none",
                        "primary_color": "#C96F45",
                        "secondary_color": "#F2B56B",
                        "color_rationale": "따뜻한 대화와 커피를 닮은 색",
                    },
                ]

        class FakeImageClient:
            model = "google/nano-banana-2"

            def __init__(self):
                self.prompts = []

            def generate_image(self, prompt, reference_uri):
                self.prompts.append((prompt, reference_uri))
                return f"https://example.com/{len(self.prompts)}.png"

        image_client = FakeImageClient()
        result = agent.generate_log_stickers(
            ["퇴근길에 비를 맞았다", "친구와 카페에 갔다"],
            style_reference="data:image/png;base64,abc",
            output_dir=None,
            claude_client=FakeClaude(),
            image_client=image_client,
        )

        self.assertEqual(len(result["stickers"]), 2)
        self.assertEqual(result["stickers"][0]["symbol"], "umbrella")
        self.assertEqual(result["stickers"][1]["symbol"], "coffee mug")
        self.assertEqual(result["sources"]["sticker_count"], 2)
        self.assertEqual(len(image_client.prompts), 2)

    def test_cli_accepts_repeated_logs(self):
        args = agent.build_arg_parser().parse_args(["--log", "비가 왔다", "--log", "커피를 마셨다"])
        self.assertEqual(args.log, ["비가 왔다", "커피를 마셨다"])


if __name__ == "__main__":
    unittest.main()
