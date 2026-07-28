from __future__ import annotations

import unittest
from typing import Any

from agent.spotify_track_validator import (
    extract_spotify_track_id,
    filter_playable_spotify_tracks,
    validate_spotify_track,
)


TRACK_ID = "00aqkszHIFdUiJJWMX6jEI"


def candidate(track_id: str = TRACK_ID) -> dict[str, Any]:
    return {
        "id": track_id,
        "title": "Test song",
        "spotify_url": f"https://open.spotify.com/track/{track_id}",
        "available_countries": ["KR", "US"],
    }


class SpotifyTrackValidatorTests(unittest.TestCase):
    def test_extracts_track_id_from_spotify_url(self) -> None:
        self.assertEqual(extract_spotify_track_id(candidate()), TRACK_ID)

    def test_rejects_market_restricted_track(self) -> None:
        result = validate_spotify_track(
            candidate(),
            "token",
            fetcher=lambda track_id, token: {
                "id": track_id,
                "is_playable": False,
                "restrictions": {"reason": "market"},
            },
        )

        self.assertEqual(result["status"], "unplayable")
        self.assertEqual(result["reason"], "market")

    def test_keeps_explicit_track_for_age_verification_notice(self) -> None:
        explicit_track = candidate()
        playable, diagnostics = filter_playable_spotify_tracks(
            [explicit_track],
            "token",
            fetcher=lambda track_id, token: {
                "id": track_id,
                "is_playable": False,
                "restrictions": {"reason": "explicit"},
            },
        )

        self.assertEqual(playable, [explicit_track])
        self.assertEqual(diagnostics[0]["status"], "explicit")
        self.assertEqual(diagnostics[0]["reason"], "explicit")

    def test_uses_relinked_playable_spotify_track_url(self) -> None:
        replacement_id = "3uNf0Trx5NBhGq1qWkgK8G"
        result = validate_spotify_track(
            candidate(),
            "token",
            fetcher=lambda track_id, token: {
                "id": replacement_id,
                "is_playable": True,
                "external_urls": {
                    "spotify": f"https://open.spotify.com/track/{replacement_id}"
                },
            },
        )

        self.assertEqual(result["status"], "playable")
        self.assertEqual(
            result["track"]["spotify_url"],
            f"https://open.spotify.com/track/{replacement_id}",
        )

    def test_keeps_unknown_validation_but_removes_known_unplayable_track(self) -> None:
        playable, diagnostics = filter_playable_spotify_tracks(
            [candidate(), candidate("3uNf0Trx5NBhGq1qWkgK8G")],
            "token",
            fetcher=lambda track_id, token: (
                {"_validation_status": "unknown", "_validation_reason": "spotify_http_429"}
                if track_id == TRACK_ID
                else {
                    "id": track_id,
                    "is_playable": False,
                    "restrictions": {"reason": "product"},
                }
            ),
        )

        self.assertEqual([track["id"] for track in playable], [TRACK_ID])
        self.assertEqual(
            [item["status"] for item in diagnostics],
            ["unknown", "unplayable"],
        )

    def test_without_token_rejects_known_non_korean_track(self) -> None:
        non_korean = candidate()
        non_korean["available_countries"] = ["US"]

        playable, diagnostics = filter_playable_spotify_tracks(
            [non_korean],
            None,
        )

        self.assertEqual(playable, [])
        self.assertEqual(diagnostics[0]["reason"], "not_available_in_kr")


if __name__ == "__main__":
    unittest.main()
