import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from agent.emoji_sticker_agent import (
    AnthropicStickerClient,
    apply_sticker_palette,
    build_sticker_prompt,
    make_white_background_transparent,
)


class StickerPromptTests(unittest.TestCase):
    def test_requests_album_style_die_cut_sticker_without_text(self) -> None:
        prompt = build_sticker_prompt(
            {
                "concept": "비 오는 퇴근길에 차분해진 모습",
                "symbol": "slightly tilted umbrella",
                "emotion_label": "차분함",
                "emotion_intensity": 0.78,
                "eye_shape": "none",
                "mouth_shape": "none",
                "accent": "one small raindrop",
                "primary_color": "#8FB7C9",
                "secondary_color": "#F0B45D",
            }
        )

        self.assertIn("cute hand-drawn sticker illustration", prompt)
        self.assertIn("scrapbook or diary album", prompt)
        self.assertIn("soft, rounded silhouette", prompt)
        self.assertIn("warm-charcoal or deep colored-pencil outlines", prompt)
        self.assertIn("light paper-grain or colored-pencil texture", prompt)
        self.assertIn("no harsh scratches", prompt)
        self.assertIn("smooth opaque white die-cut sticker border", prompt)
        self.assertIn("Do not add a face, eyes, or mouth", prompt)
        self.assertIn(
            "no text, letters, numbers, punctuation, captions, speech bubbles",
            prompt,
        )
        self.assertIn("never an album cover, poster, label, package", prompt)
        self.assertIn("black-heavy artwork", prompt)
        self.assertIn("warm, playful, approachable, and cute", prompt)

    def test_keeps_optional_expression_when_brief_calls_for_a_face(self) -> None:
        prompt = build_sticker_prompt(
            {
                "concept": "마감 뒤 완전히 지친 밤",
                "symbol": "melting alarm clock mascot",
                "emotion_label": "피곤함",
                "emotion_intensity": 0.91,
                "eye_shape": "uneven half-closed eyes",
                "mouth_shape": "short flat mouth",
                "accent": "one small sweat drop",
                "primary_color": "#D95A54",
                "secondary_color": "#F3C75F",
            }
        )

        self.assertIn("uneven half-closed eyes", prompt)
        self.assertIn("short flat mouth", prompt)
        self.assertIn("no visible eye whites", prompt)
        self.assertIn("large open mouth", prompt)
        self.assertIn("Do not default to a smile", prompt)

    def test_requests_hip_zine_style_without_weakening_text_ban(self) -> None:
        prompt = build_sticker_prompt(
            {
                "concept": "비 오는 퇴근길",
                "symbol": "umbrella",
                "emotion_label": "차분함",
                "emotion_intensity": 0.78,
                "eye_shape": "none",
                "mouth_shape": "none",
                "accent": "one small raindrop",
                "primary_color": "#5B8DBE",
                "secondary_color": "#F4A261",
            },
            style_variant="hip",
        )

        self.assertIn("hip indie-zine, record-shop, and street-culture", prompt)
        self.assertIn("risograph or screen-print layers", prompt)
        self.assertIn("slightly misregistered color edge", prompt)
        self.assertIn("witty, current, collectible, and effortlessly cool", prompt)
        self.assertIn("rounded corners", prompt)
        self.assertIn("medium-weight muted deep-plum contours", prompt)
        self.assertIn("slightly softer and more approachable finish", prompt)
        self.assertIn("Avoid heavy all-around black contours", prompt)
        self.assertIn(
            "no text, letters, numbers, punctuation, captions, speech bubbles",
            prompt,
        )
        self.assertIn("without becoming aggressive, scary", prompt)

    def test_rejects_unknown_style_variant(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported style variant"):
            build_sticker_prompt(
                {
                    "concept": "산책",
                    "symbol": "shoe",
                    "emotion_label": "상쾌함",
                    "emotion_intensity": 0.7,
                    "eye_shape": "none",
                    "mouth_shape": "none",
                    "accent": "none",
                    "primary_color": "#5B8DBE",
                    "secondary_color": "#F4A261",
                },
                style_variant="unknown",
            )


class StickerBriefPromptTests(unittest.TestCase):
    def test_concept_agent_prefers_specific_symbols_without_forcing_animals(self) -> None:
        response = {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "stickers": [
                                {
                                    "log_id": "1",
                                    "concept": "비 오는 퇴근길",
                                    "symbol": "slightly tilted umbrella",
                                    "emotion_label": "차분함",
                                    "emotion_intensity": 0.78,
                                    "eye_shape": "wide staring eyes",
                                    "mouth_shape": "small O-shaped mouth",
                                    "accent": "three Z marks",
                                    "primary_color": "#8FB7C9",
                                    "secondary_color": "#F0B45D",
                                    "color_rationale": "차분한 비와 따뜻한 귀가를 표현",
                                }
                            ]
                        }
                    ),
                }
            ]
        }
        with patch("agent.emoji_sticker_agent._json_request", return_value=response) as request_json:
            client = AnthropicStickerClient(api_key="test-key")
            briefs = client.create_sticker_briefs(
                [{"id": "1", "text": "비 오는 날 퇴근했다", "emotions": {}}]
            )

        self.assertEqual(briefs[0]["eye_shape"], "tiny gently tilted dot eyes")
        self.assertEqual(briefs[0]["mouth_shape"], "tiny closed softly curved mouth")
        self.assertEqual(briefs[0]["accent"], "none")
        request = request_json.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        instructions = payload["messages"][0]["content"]
        self.assertIn("one concrete central visual symbol", instructions)
        self.assertIn("do not default every log to a cute animal", instructions)
        self.assertIn("return 'none' for both eye shape and mouth shape", instructions)
        self.assertIn("instead of wide staring eyes or a screaming mouth", instructions)
        self.assertIn("Never use visible eye whites", instructions)
        self.assertIn("never use alarm punctuation", instructions)
        self.assertIn("sleep-letter glyphs", instructions)
        self.assertIn("unless the log itself is explicitly about music", instructions)


class StickerPaletteTests(unittest.TestCase):
    def test_preserves_ink_outline_and_white_sticker_border(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "sticker.png"
            image = Image.new("RGBA", (3, 1))
            image.putdata(
                [
                    (0, 0, 0, 255),
                    (250, 250, 250, 255),
                    (210, 210, 210, 255),
                ]
            )
            image.save(image_path)

            apply_sticker_palette(
                image_path,
                primary_color="#8FB7C9",
                secondary_color="#F0B45D",
            )

            with Image.open(image_path) as result:
                self.assertEqual(result.getpixel((0, 0)), (82, 70, 61, 255))
                self.assertEqual(result.getpixel((1, 0)), (255, 255, 255, 255))
                self.assertEqual(result.getpixel((2, 0)), (210, 210, 210, 255))

    def test_uses_muted_deep_plum_outline_for_hip_variant(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "sticker.png"
            Image.new("RGBA", (1, 1), (0, 0, 0, 255)).save(image_path)

            apply_sticker_palette(
                image_path,
                primary_color="#5B8DBE",
                secondary_color="#F4A261",
                outline_color="#4A4052",
            )

            with Image.open(image_path) as result:
                self.assertEqual(result.getpixel((0, 0)), (74, 64, 82, 255))


class WhiteBackgroundTransparencyTests(unittest.TestCase):
    def test_preserves_white_enclosed_by_sticker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "sticker.png"
            image = Image.new("RGBA", (7, 7), "white")
            for x in range(2, 5):
                for y in range(2, 5):
                    image.putpixel((x, y), (20, 80, 160, 255))
            image.putpixel((3, 3), (255, 255, 255, 0))
            image.save(image_path)

            make_white_background_transparent(image_path)

            with Image.open(image_path) as result:
                self.assertEqual(result.getpixel((0, 0))[3], 0)
                self.assertEqual(result.getpixel((2, 2))[3], 255)
                self.assertEqual(result.getpixel((3, 3)), (255, 255, 255, 255))

    def test_fades_only_light_pixels_connected_to_canvas_edge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "sticker.png"
            image = Image.new("RGBA", (5, 5), "white")
            image.putpixel((1, 2), (235, 235, 235, 255))
            image.putpixel((2, 2), (100, 100, 100, 255))
            image.save(image_path)

            make_white_background_transparent(image_path)

            with Image.open(image_path) as result:
                self.assertEqual(result.getpixel((0, 2))[3], 0)
                self.assertEqual(result.getpixel((1, 2))[3], 128)
                self.assertEqual(result.getpixel((2, 2))[3], 255)


if __name__ == "__main__":
    unittest.main()
