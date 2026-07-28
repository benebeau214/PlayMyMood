from __future__ import annotations

import unittest
from typing import Any

from agent.mood_music_agent import (
    ReccoBeatsClient,
    filter_tracks_by_emotion_compatibility,
    recommend_music,
    track_identity_keys,
)


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

    def test_excludes_tracks_recommended_during_cooldown(self) -> None:
        recco = BatchedRecco(
            [[
                raw_track("recent-track", "Recently Recommended", "Artist A", popularity=99),
                raw_track("fresh-track", "Fresh Recommendation", "Artist B", popularity=50),
            ]]
        )

        result = recommend_music(
            "저녁 휴식",
            {"calm": 0.7},
            limit=1,
            excluded_track_ids={"recent-track"},
            claude_client=ProfileOnlyClaude(),
            recco_client=recco,
        )

        self.assertEqual([track["id"] for track in result["recommendations"]], ["fresh-track"])
        self.assertTrue(any("cooldown excluded" in warning for warning in result["warnings"]))

    def test_excludes_same_spotify_track_even_when_recco_id_changes(self) -> None:
        duplicate = raw_track("new-recco-id", "Same Song", "Same Artist", popularity=99)
        duplicate["href"] = "https://open.spotify.com/track/1234567890ABCDEFGHIJKL"
        fresh = raw_track("fresh-track", "Fresh Recommendation", "Artist B", popularity=50)
        excluded = track_identity_keys({
            "recco_track_id": "old-recco-id",
            "spotify_url": "https://open.spotify.com/track/1234567890ABCDEFGHIJKL",
            "title": "Same Song",
            "artists": ["Same Artist"],
        })
        recco = BatchedRecco([[duplicate, fresh]])

        result = recommend_music(
            "산책",
            {"calm": 0.7},
            limit=1,
            excluded_track_ids=excluded,
            claude_client=ProfileOnlyClaude(),
            recco_client=recco,
        )

        self.assertEqual([track["id"] for track in result["recommendations"]], ["fresh-track"])

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


class AudioFeatureAndMoodCompatibilityTests(unittest.TestCase):
    def test_reccobeats_uses_current_per_track_audio_feature_endpoint(self) -> None:
        client = ReccoBeatsClient(base_url="https://example.test")
        requested_paths: list[str] = []

        def fake_get(path: str, params: dict[str, Any]) -> dict[str, Any]:
            requested_paths.append(path)
            track_id = path.split("/")[3]
            return {"id": track_id, "valence": 0.8, "energy": 0.7}

        client._get = fake_get  # type: ignore[method-assign]
        features = client.get_audio_features(["track-1", "track-2"])

        self.assertEqual(set(features), {"track-1", "track-2"})
        self.assertEqual(
            set(requested_paths),
            {
                "/v1/track/track-1/audio-features",
                "/v1/track/track-2/audio-features",
            },
        )

    def test_excited_satisfied_snack_excludes_low_valence_track(self) -> None:
        wicked_games = {
            "id": "wicked-games",
            "title": "Wicked Games",
            "audio_features": {
                "valence": 0.258,
                "energy": 0.57,
                "danceability": 0.606,
                "tempo": 114.033,
            },
        }
        cheerful_track = {
            "id": "cheerful",
            "title": "Cheerful snack song",
            "audio_features": {
                "valence": 0.82,
                "energy": 0.76,
                "danceability": 0.74,
                "tempo": 128,
            },
        }
        unknown_mood_track = {
            "id": "unknown",
            "title": "Popular but unanalyzed song",
            "popularity": 99,
            "audio_features": {},
        }
        warnings: list[str] = []

        filtered = filter_tracks_by_emotion_compatibility(
            [wicked_games, cheerful_track, unknown_mood_track],
            {
                "joy": 0.75,
                "excitement": 0.9,
                "calm": 0.55,
                "confidence": 0.65,
            },
            warnings,
        )

        self.assertEqual([track["id"] for track in filtered], ["cheerful", "unknown"])
        self.assertTrue(any("Wicked Games" in warning for warning in warnings))
        self.assertTrue(any("audio features unavailable" in warning for warning in warnings))

    def test_mixed_negative_emotion_does_not_force_bright_music(self) -> None:
        low_valence_track = {
            "id": "bittersweet",
            "title": "Bittersweet",
            "audio_features": {"valence": 0.3, "energy": 0.5},
        }

        filtered = filter_tracks_by_emotion_compatibility(
            [low_valence_track],
            {"joy": 0.7, "sadness": 0.65},
        )

        self.assertEqual(filtered, [low_valence_track])


if __name__ == "__main__":
    unittest.main()
