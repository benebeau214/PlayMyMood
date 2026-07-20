import unittest
from unittest.mock import patch

from agent import album_cover_agent as agent


def sample_music_result():
    return {
        "mood_profile": {
            "mood_label": "rainy evening recovery",
            "listening_intent": "let the day settle",
            "target_audio_features": {"valence": 0.4, "energy": 0.3, "tempo": 88},
        },
        "recommendations": [
            {
                "title": "Song A",
                "artists": ["Artist A"],
                "fit_reason": "quiet and reflective",
                "audio_features": {"valence": 0.42, "energy": 0.31, "tempo": 90},
            },
            {
                "title": "Song B",
                "artists": ["Artist B"],
                "fit_reason": "softly hopeful",
                "audio_features": {"valence": 0.5, "energy": 0.35, "tempo": 92},
            },
        ],
    }


class ValidationTests(unittest.TestCase):
    def test_normalize_style_accepts_korean_aliases(self):
        self.assertEqual(agent.normalize_style("애니메"), "anime")
        self.assertEqual(agent.normalize_style("감성"), "emotional")

    def test_normalize_style_rejects_unknown_style(self):
        with self.assertRaisesRegex(ValueError, "cover_style"):
            agent.normalize_style("vaporwave")

    def test_rejects_emotion_scores_outside_zero_to_one(self):
        with self.assertRaisesRegex(ValueError, "between 0.0 and 1.0"):
            agent.validate_inputs("비 오는 퇴근길", {"tired": 80}, sample_music_result(), "감성")

    def test_requires_at_least_one_recommendation(self):
        with self.assertRaisesRegex(ValueError, "at least one recommendation"):
            agent.compact_recommendations({"recommendations": []})

    def test_env_parser_accepts_existing_nonstandard_labels(self):
        parsed = agent.parse_env_text(
            "claude token(api key): sk-ant-test\nreplicate token: r8_test\n"
        )
        self.assertEqual(parsed["ANTHROPIC_API_KEY"], "sk-ant-test")
        self.assertEqual(parsed["REPLICATE_API_TOKEN"], "r8_test")


class PromptAndReplicateTests(unittest.TestCase):
    def test_normalize_cover_brief_requires_prompt(self):
        with self.assertRaisesRegex(agent.ModelOutputError, "image_prompt"):
            agent.normalize_cover_brief({"visual_summary": "고요한 하루"})

    def test_replicate_input_is_fixed_to_square_1k_png(self):
        payload = agent.build_replicate_input("A quiet square album cover.")
        self.assertEqual(payload["aspect_ratio"], "1:1")
        self.assertEqual(payload["resolution"], "1K")
        self.assertEqual(payload["output_format"], "png")
        self.assertFalse(payload["google_search"])
        self.assertFalse(payload["image_search"])

    def test_replicate_client_retries_rate_limit_response(self):
        client = agent.ReplicateImageClient(api_token="r8_test", max_rate_limit_retries=1)
        with (
            patch(
                "agent.album_cover_agent._json_request",
                side_effect=[
                    agent.RateLimitError("try later", retry_after=2),
                    {"status": "succeeded", "output": "https://example.com/cover.png"},
                ],
            ) as request_mock,
            patch("agent.album_cover_agent.time.sleep") as sleep_mock,
        ):
            output = client.generate_image("A square cover.")

        self.assertEqual(output, "https://example.com/cover.png")
        self.assertEqual(request_mock.call_count, 2)
        sleep_mock.assert_called_once_with(2)


class EndToEndTests(unittest.TestCase):
    def test_generate_playlist_cover_uses_music_result_and_selected_style(self):
        class FakeClaude:
            model = "claude-haiku-4-5"

            def create_cover_brief(
                self,
                situation,
                emotions,
                mood_profile,
                recommendations,
                cover_style,
            ):
                self.received = {
                    "situation": situation,
                    "emotions": emotions,
                    "mood_profile": mood_profile,
                    "recommendations": recommendations,
                    "cover_style": cover_style,
                }
                return {
                    "visual_summary": "비가 그친 뒤 하루가 조용히 가라앉는 장면",
                    "image_prompt": "A poetic square daily music-diary playlist cover.",
                    "design_notes": {
                        "palette": ["midnight blue", "muted amber"],
                        "composition": "single focal point",
                        "lighting": "soft reflected light",
                        "medium": "atmospheric editorial artwork",
                    },
                }

        class FakeImageClient:
            model = "google/nano-banana-2"

            def generate_image(self, image_prompt):
                self.image_prompt = image_prompt
                return "https://example.com/cover.png"

        claude = FakeClaude()
        image_client = FakeImageClient()
        result = agent.generate_playlist_cover(
            "비 오는 퇴근길 버스 정류장",
            {"tired": 0.8, "calm": 0.4},
            sample_music_result(),
            "감성",
            claude_client=claude,
            image_client=image_client,
        )

        self.assertEqual(claude.received["cover_style"], "emotional")
        self.assertEqual(len(claude.received["recommendations"]), 2)
        self.assertEqual(result["cover_style"], "emotional")
        self.assertEqual(result["cover"]["image_url"], "https://example.com/cover.png")
        self.assertEqual(result["sources"]["playlist_track_count"], 2)

    def test_cli_parser_accepts_daily_playlist_inputs(self):
        args = agent.build_arg_parser().parse_args(
            [
                "--situation",
                "비 오는 퇴근길",
                "--emotion",
                "tired=0.8",
                "--music-result",
                "result.json",
                "--style",
                "아티스틱",
            ]
        )
        self.assertEqual(args.style, "아티스틱")


if __name__ == "__main__":
    unittest.main()
