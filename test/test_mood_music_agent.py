from __future__ import annotations

import unittest
from typing import Any

from agent.mood_music_agent import recommend_music


def raw_track(track_id: str, title: str, artist: str, popularity: int = 50) -> dict[str, Any]:
    return {
        "id": track_id,
        "trackTitle": title,
        "artists": [{"name": artist}],
        "availableCountries": "KR,US",
        "durationMs": 180_000,
        "href": f"https://open.spotify.com/track/{track_id}",
        "popularity": popularity,
    }


class PreferenceFilteringClaude:
    model = "fake-claude"

    def __init__(self, accepted_artists: set[str]) -> None:
        self.accepted_artists = accepted_artists
        self.filter_calls = 0

    def create_mood_profile(
        self,
        situation: str,
        emotions: dict[str, float],
        preferences: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "mood_label": "테스트",
            "listening_intent": "테스트",
            "target_audio_features": {
                "valence": 0.5,
                "danceability": 0.5,
                "energy": 0.5,
                "tempo": 100,
                "popularity": 50,
            },
            "seed_artists": ["Seed Artist"],
            "seed_tracks": [],
            "reasoning_for_user": "테스트",
        }

    def filter_tracks_by_preferences(
        self,
        situation: str,
        preferences: dict[str, Any],
        tracks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self.filter_calls += 1
        return {
            "accepted_ids": [
                str(track["id"])
                for track in tracks
                if any(artist in self.accepted_artists for artist in track.get("artists", []))
            ]
        }


class ProfileOnlyClaude:
    model = "fake-claude"

    def create_mood_profile(
        self,
        situation: str,
        emotions: dict[str, float],
        preferences: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return PreferenceFilteringClaude(set()).create_mood_profile(situation, emotions, preferences)


class BatchedRecco:
    base_url = "fake-recco"

    def __init__(self, batches: list[list[dict[str, Any]]]) -> None:
        self.batches = batches
        self.recommendation_calls = 0
        self.requested_sizes: list[int] = []

    def search_artist(self, name: str, size: int = 5) -> list[dict[str, Any]]:
        return [{"id": "seed-artist-id", "name": name}]

    def get_artist_tracks(self, artist_id: str, size: int = 5) -> list[dict[str, Any]]:
        return [{"id": "seed-track-id"}]

    def get_tracks(self, track_ids: list[str]) -> list[dict[str, Any]]:
        return []

    def get_recommendations(
        self,
        seeds: list[str],
        size: int,
        target_features: dict[str, float] | None = None,
    ) -> list[dict[str, Any]]:
        self.requested_sizes.append(size)
        index = min(self.recommendation_calls, len(self.batches) - 1)
        self.recommendation_calls += 1
        return self.batches[index]

    def get_audio_features(self, track_ids: list[str]) -> dict[str, dict[str, Any]]:
        return {
            track_id: {
                "valence": 0.5,
                "danceability": 0.5,
                "energy": 0.5,
                "tempo": 100,
            }
            for track_id in track_ids
        }


class PreferenceRetryTests(unittest.TestCase):
    def test_retries_until_preference_matches(self) -> None:
        claude = PreferenceFilteringClaude({"K Artist"})
        recco = BatchedRecco(
            [
                [raw_track("foreign-1", "Foreign Song", "Foreign Artist")],
                [raw_track("kpop-1", "K-pop Song", "K Artist")],
            ]
        )

        result = recommend_music(
            "기분 전환",
            {"joy": 0.7},
            limit=1,
            preferences={"preferred_genres": ["K-pop"]},
            claude_client=claude,
            recco_client=recco,
        )

        self.assertEqual([track["id"] for track in result["recommendations"]], ["kpop-1"])
        self.assertEqual(recco.recommendation_calls, 2)
        self.assertEqual(claude.filter_calls, 2)
        self.assertGreaterEqual(recco.requested_sizes[0], 12)

    def test_accumulates_matches_until_limit_is_met(self) -> None:
        claude = PreferenceFilteringClaude({"K Artist"})
        recco = BatchedRecco(
            [
                [
                    raw_track("kpop-1", "First K-pop Song", "K Artist"),
                    raw_track("foreign-1", "Foreign Song", "Foreign Artist"),
                ],
                [raw_track("kpop-2", "Second K-pop Song", "K Artist")],
            ]
        )

        result = recommend_music(
            "집중하고 싶은 밤",
            {"focus": 0.8},
            limit=2,
            preferences={"preferred_genres": ["K-pop"]},
            claude_client=claude,
            recco_client=recco,
        )

        self.assertEqual(
            {track["id"] for track in result["recommendations"]},
            {"kpop-1", "kpop-2"},
        )
        self.assertEqual(recco.recommendation_calls, 2)

    def test_exhausted_retry_budget_returns_best_available_fallback(self) -> None:
        claude = PreferenceFilteringClaude({"K Artist"})
        recco = BatchedRecco(
            [
                [raw_track("foreign-1", "Foreign Song 1", "Foreign Artist", popularity=40)],
                [raw_track("foreign-2", "Foreign Song 2", "Foreign Artist", popularity=70)],
                [raw_track("foreign-3", "Foreign Song 3", "Foreign Artist", popularity=55)],
            ]
        )

        result = recommend_music(
            "산책",
            {"calm": 0.7},
            limit=1,
            preferences={"preferred_genres": ["K-pop"]},
            claude_client=claude,
            recco_client=recco,
        )

        self.assertEqual([track["id"] for track in result["recommendations"]], ["foreign-2"])
        self.assertEqual(recco.recommendation_calls, 3)
        self.assertTrue(any("preference_fallback" in warning for warning in result["warnings"]))

    def test_without_genre_preferences_searches_once(self) -> None:
        claude = PreferenceFilteringClaude({"K Artist"})
        recco = BatchedRecco(
            [
                [raw_track("foreign-1", "Foreign Song", "Foreign Artist")],
                [raw_track("unused", "Unused Song", "K Artist")],
            ]
        )

        result = recommend_music(
            "산책",
            {"calm": 0.7},
            limit=1,
            claude_client=claude,
            recco_client=recco,
        )

        self.assertEqual([track["id"] for track in result["recommendations"]], ["foreign-1"])
        self.assertEqual(recco.recommendation_calls, 1)
        self.assertEqual(claude.filter_calls, 0)

    def test_missing_evaluator_uses_ranked_fallback(self) -> None:
        recco = BatchedRecco([[raw_track("foreign-1", "Foreign Song", "Foreign Artist")]])

        result = recommend_music(
            "산책",
            {"calm": 0.7},
            limit=1,
            preferences={"preferred_genres": ["K-pop"]},
            claude_client=ProfileOnlyClaude(),
            recco_client=recco,
        )

        self.assertEqual([track["id"] for track in result["recommendations"]], ["foreign-1"])
        self.assertEqual(recco.recommendation_calls, 1)
        self.assertTrue(any("AI preference filter unavailable" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
