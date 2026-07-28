"""Validate recommendation candidates against the current Spotify user."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any


SPOTIFY_TRACK_ID_PATTERN = re.compile(r"(?:track[/:])([A-Za-z0-9]{22})")
SPOTIFY_BASE62_ID_PATTERN = re.compile(r"^[A-Za-z0-9]{22}$")


def extract_spotify_track_id(track: dict[str, Any]) -> str | None:
    spotify_url = str(track.get("spotify_url") or "")
    match = SPOTIFY_TRACK_ID_PATTERN.search(spotify_url)
    if match:
        return match.group(1)

    track_id = str(track.get("id") or "")
    if SPOTIFY_BASE62_ID_PATTERN.fullmatch(track_id):
        return track_id
    return None


def fetch_spotify_track(
    track_id: str,
    access_token: str,
    *,
    timeout: int = 12,
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"https://api.spotify.com/v1/tracks/{urllib.parse.quote(track_id)}",
        headers={
            "accept": "application/json",
            "authorization": f"Bearer {access_token}",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"_validation_status": "unplayable", "_validation_reason": "not_found"}
        return {
            "_validation_status": "unknown",
            "_validation_reason": f"spotify_http_{exc.code}",
        }
    except (urllib.error.URLError, TimeoutError) as exc:
        return {
            "_validation_status": "unknown",
            "_validation_reason": f"spotify_network_error:{exc}",
        }

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return {
            "_validation_status": "unknown",
            "_validation_reason": "spotify_invalid_json",
        }
    return parsed if isinstance(parsed, dict) else {
        "_validation_status": "unknown",
        "_validation_reason": "spotify_invalid_response",
    }


def validate_spotify_track(
    track: dict[str, Any],
    access_token: str,
    *,
    fetcher: Callable[[str, str], dict[str, Any]] = fetch_spotify_track,
) -> dict[str, Any]:
    track_id = extract_spotify_track_id(track)
    if not track_id:
        return {
            "status": "unplayable",
            "reason": "missing_spotify_track_id",
            "track": track,
        }

    spotify_track = fetcher(track_id, access_token)
    preset_status = spotify_track.get("_validation_status")
    if preset_status:
        return {
            "status": str(preset_status),
            "reason": str(spotify_track.get("_validation_reason") or ""),
            "track": track,
        }

    restriction = spotify_track.get("restrictions")
    restriction_reason = (
        str(restriction.get("reason") or "")
        if isinstance(restriction, dict)
        else ""
    )
    if spotify_track.get("is_playable") is False or restriction_reason:
        return {
            "status": "unplayable",
            "reason": restriction_reason or "is_playable_false",
            "track": track,
        }

    resolved = dict(track)
    resolved_id = str(spotify_track.get("id") or track_id)
    external_urls = spotify_track.get("external_urls")
    spotify_url = (
        str(external_urls.get("spotify") or "")
        if isinstance(external_urls, dict)
        else ""
    )
    resolved["spotify_url"] = spotify_url or f"https://open.spotify.com/track/{resolved_id}"
    resolved["spotify_track_id"] = resolved_id
    return {"status": "playable", "reason": "", "track": resolved}


def filter_playable_spotify_tracks(
    tracks: list[dict[str, Any]],
    access_token: str | None,
    *,
    fetcher: Callable[[str, str], dict[str, Any]] = fetch_spotify_track,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    playable: list[dict[str, Any]] = []
    diagnostics: list[dict[str, str]] = []

    for track in tracks:
        if access_token:
            validation = validate_spotify_track(
                track,
                access_token,
                fetcher=fetcher,
            )
        else:
            countries = track.get("available_countries")
            known_countries = (
                {str(country).upper() for country in countries}
                if isinstance(countries, list)
                else set()
            )
            validation = {
                "status": (
                    "unplayable"
                    if known_countries and "KR" not in known_countries
                    else "unknown"
                ),
                "reason": (
                    "not_available_in_kr"
                    if known_countries and "KR" not in known_countries
                    else "spotify_token_missing"
                ),
                "track": track,
            }

        status = str(validation["status"])
        if status != "unplayable":
            playable.append(validation["track"])
        diagnostics.append(
            {
                "id": str(track.get("id") or ""),
                "status": status,
                "reason": str(validation.get("reason") or ""),
            }
        )
    return playable, diagnostics
