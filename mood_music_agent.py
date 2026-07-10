"""Mood-based music recommendation agent using Claude and ReccoBeats."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5"
RECCOBEATS_BASE_URL = "https://api.reccobeats.com"
PREFERRED_COUNTRIES = ("KR", "US")
HTTP_USER_AGENT = "Mozilla/5.0 (compatible; MoodMusicAgent/0.1; +https://reccobeats.com)"
RECCOBEATS_TARGET_KEYS = ("valence", "danceability", "energy", "tempo", "popularity")
PREFERENCE_KEYS = ("preferred_genres", "avoid_genres", "preferred_artists", "avoid_artists")


class ConfigurationError(RuntimeError):
    """Raised when local configuration is missing or invalid."""


class ModelOutputError(RuntimeError):
    """Raised when Claude returns output the agent cannot parse."""


class ReccoBeatsError(RuntimeError):
    """Raised when ReccoBeats returns an unusable response."""


def validate_inputs(situation: str, emotions: dict[str, float], limit: int) -> None:
    if not situation or not situation.strip():
        raise ValueError("situation must be non-empty")
    if not 1 <= limit <= 25:
        raise ValueError("limit must be between 1 and 25")

    for name, value in emotions.items():
        if not name or not str(name).strip():
            raise ValueError("emotion names must be non-empty")
        if not isinstance(value, int | float):
            raise ValueError(f"emotion '{name}' must be numeric")
        if not 0.0 <= float(value) <= 1.0:
            raise ValueError(f"emotion '{name}' must be between 0.0 and 1.0")


def parse_emotion_args(raw_emotions: list[str]) -> dict[str, float]:
    emotions: dict[str, float] = {}
    for raw in raw_emotions:
        if "=" not in raw:
            raise ValueError(f"emotion must use name=value format: {raw}")
        name, value_text = raw.split("=", 1)
        name = name.strip()
        if not name:
            raise ValueError("emotion names must be non-empty")
        try:
            value = float(value_text)
        except ValueError as exc:
            raise ValueError(f"emotion '{name}' must be numeric") from exc
        emotions[name] = value
    return emotions


def normalize_preferences(raw_preferences: Any) -> dict[str, list[str]]:
    if not raw_preferences:
        return {}
    if not isinstance(raw_preferences, dict):
        raise ValueError("preferences must be a JSON object")

    preferences: dict[str, list[str]] = {}
    for key in PREFERENCE_KEYS:
        raw_value = raw_preferences.get(key)
        if raw_value is None:
            continue
        if isinstance(raw_value, str):
            values = [item.strip() for item in raw_value.split(",")]
        elif isinstance(raw_value, list):
            values = [str(item).strip() for item in raw_value]
        else:
            raise ValueError(f"preference '{key}' must be a string or list")
        cleaned = [value for value in values if value]
        if cleaned:
            preferences[key] = cleaned
    return preferences


def parse_preferences_text(text: str) -> dict[str, list[str]]:
    if not text or not text.strip():
        return {}
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"preferences must be valid JSON: {exc}") from exc
    return normalize_preferences(raw)


def parse_env_text(text: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("'\"")
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            normalized = re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_")
            if "claude" in normalized and ("api_key" in normalized or "token" in normalized):
                env["ANTHROPIC_API_KEY"] = value.strip().strip("'\"")
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


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _coerce_feature_map(raw: Any) -> dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    features: dict[str, float] = {}
    for key, value in raw.items():
        normalized_key = str(key).strip().lower()
        if not isinstance(value, int | float):
            continue
        numeric = float(value)
        if normalized_key in ("valence", "danceability", "energy"):
            features[normalized_key] = _clamp(numeric, 0.0, 1.0)
        elif normalized_key == "tempo":
            features[normalized_key] = _clamp(numeric, 40.0, 220.0)
        elif normalized_key == "popularity":
            features[normalized_key] = _clamp(numeric, 0.0, 100.0)
        elif normalized_key == "tempo_mood":
            # Backward-compatible bridge for older Claude outputs.
            features["tempo"] = _clamp(70.0 + (_clamp(numeric, 0.0, 1.0) * 90.0), 40.0, 220.0)
    return features


def normalize_mood_profile(raw_profile: dict[str, Any]) -> dict[str, Any]:
    seed_artists = raw_profile.get("seed_artists") or []
    seed_tracks = raw_profile.get("seed_tracks") or []
    if not isinstance(seed_artists, list):
        seed_artists = []
    if not isinstance(seed_tracks, list):
        seed_tracks = []

    profile = {
        "mood_label": str(raw_profile.get("mood_label") or "mixed mood"),
        "listening_intent": str(raw_profile.get("listening_intent") or "match the current mood"),
        "target_audio_features": _coerce_feature_map(raw_profile.get("target_audio_features")),
        "seed_artists": [str(item).strip() for item in seed_artists if str(item).strip()],
        "seed_tracks": [str(item).strip() for item in seed_tracks if str(item).strip()],
        "reasoning_for_user": str(raw_profile.get("reasoning_for_user") or ""),
    }
    if not profile["seed_artists"] and not profile["seed_tracks"]:
        raise ModelOutputError("Claude profile must include at least one seed artist or seed track")
    return profile


def build_mood_profile(
    situation: str,
    emotions: dict[str, float],
    claude_client: Any,
    preferences: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    preferences = normalize_preferences(preferences or {})
    if preferences:
        raw_profile = claude_client.create_mood_profile(situation, emotions, preferences)
    else:
        raw_profile = claude_client.create_mood_profile(situation, emotions)
    return normalize_mood_profile(raw_profile)


class AnthropicMoodClient:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        timeout: int = 30,
    ) -> None:
        env_file = load_env_file()
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY") or env_file.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise ConfigurationError("ANTHROPIC_API_KEY is missing")
        self.model = model or os.environ.get("ANTHROPIC_MODEL") or DEFAULT_CLAUDE_MODEL
        self.timeout = timeout

    def create_mood_profile(
        self,
        situation: str,
        emotions: dict[str, float],
        preferences: dict[str, list[str]] | None = None,
    ) -> dict[str, Any]:
        preferences = normalize_preferences(preferences or {})
        payload = {
            "model": self.model,
            "max_tokens": 900,
            "temperature": 0.4,
            "system": (
                "You are a music mood analyst. Return only one JSON object. "
                "Use well-known seed artists that ReccoBeats is likely to find."
            ),
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Create a music recommendation profile for this input.\n"
                        f"Situation: {situation}\n"
                        f"Emotion scores JSON: {json.dumps(emotions, ensure_ascii=False, sort_keys=True)}\n\n"
                        f"User preference constraints JSON: {json.dumps(preferences, ensure_ascii=False, sort_keys=True)}\n"
                        "If emotion scores are empty, infer the emotional direction from the situation text.\n"
                        "Use preferred_genres and preferred_artists to choose seed artists/tracks when musically appropriate. "
                        "Do not choose seed artists or tracks from avoid_artists. Avoid avoid_genres in the seed direction. "
                        "If preferences conflict with the situation, prioritize the situation and explain the tradeoff briefly in reasoning_for_user.\n"
                        "Return JSON with keys: mood_label, listening_intent, "
                        "target_audio_features, seed_artists, seed_tracks, reasoning_for_user. "
                        "target_audio_features must include exactly these numeric ReccoBeats targets: "
                        "valence 0.0-1.0, danceability 0.0-1.0, energy 0.0-1.0, "
                        "tempo BPM 40-220, popularity 0-100."
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
        return normalize_mood_profile(extract_json_object("\n".join(text_parts)))

    def filter_tracks_by_preferences(
        self,
        situation: str,
        preferences: dict[str, list[str]],
        tracks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        compact_tracks = [
            {
                "id": str(track.get("id") or ""),
                "title": str(track.get("title") or ""),
                "artists": [str(artist) for artist in track.get("artists", [])],
                "popularity": track.get("popularity"),
            }
            for track in tracks
            if track.get("id")
        ]
        payload = {
            "model": self.model,
            "max_tokens": 400,
            "temperature": 0.0,
            "system": (
                "You are a strict music preference filter. Return only one JSON object. "
                "Return compact JSON with no explanations."
            ),
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Filter these recommendation candidates against the user's music preferences.\n"
                        f"Situation: {situation}\n"
                        f"Preferences JSON: {json.dumps(preferences, ensure_ascii=False, sort_keys=True)}\n"
                        f"Candidate tracks JSON: {json.dumps(compact_tracks, ensure_ascii=False, sort_keys=True)}\n\n"
                        "Rules:\n"
                        "- accepted_ids must include only tracks that likely satisfy preferred_genres and do not match avoid_genres.\n"
                        "- For regional genres such as Korean R&B, K-pop, or Korean city pop, reject tracks that are not clearly Korean or by Korean/Korea-linked artists.\n"
                        "- If evidence is weak, reject the track.\n"
                        "- Do not accept tracks based on audio features alone.\n"
                        "- Return exactly this shape: {\"accepted_ids\":[\"track-id\"]}"
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
        return extract_json_object("\n".join(text_parts))


def _json_request(request: urllib.request.Request, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ReccoBeatsError(f"HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise ReccoBeatsError(f"Network error: {exc.reason}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ReccoBeatsError(f"Response was not JSON: {body[:200]}") from exc
    if not isinstance(parsed, dict):
        raise ReccoBeatsError("Response JSON must be an object")
    return parsed


def _normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def select_best_artist_match(query: str, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not candidates:
        return None
    normalized_query = _normalize_name(query)
    for candidate in candidates:
        if _normalize_name(str(candidate.get("name", ""))) == normalized_query:
            return candidate
    for candidate in candidates:
        candidate_name = _normalize_name(str(candidate.get("name", "")))
        if normalized_query and (normalized_query in candidate_name or candidate_name in normalized_query):
            return candidate
    return candidates[0]


def _content_list(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, dict):
        content = response.get("content", [])
    else:
        content = response
    if not isinstance(content, list):
        return []
    return [item for item in content if isinstance(item, dict)]


class ReccoBeatsClient:
    def __init__(self, base_url: str = RECCOBEATS_BASE_URL, timeout: int = 20) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        query = urllib.parse.urlencode(params, doseq=True)
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{query}"
        request = urllib.request.Request(
            url,
            headers={"accept": "application/json", "user-agent": HTTP_USER_AGENT},
            method="GET",
        )
        try:
            return _json_request(request, self.timeout)
        except ReccoBeatsError:
            raise

    def search_artist(self, name: str, size: int = 5) -> list[dict[str, Any]]:
        return _content_list(self._get("/v1/artist/search", {"searchText": name, "size": size}))

    def get_artist_tracks(self, artist_id: str, size: int = 5) -> list[dict[str, Any]]:
        response = self._get(f"/v1/artist/{urllib.parse.quote(artist_id)}/track", {"size": size})
        return _content_list(response)

    def get_tracks(self, track_ids: list[str]) -> list[dict[str, Any]]:
        if not track_ids:
            return []
        response = self._get("/v1/track", {"ids": track_ids})
        return _content_list(response)

    def get_recommendations(
        self,
        seeds: list[str],
        size: int,
        target_features: dict[str, float] | None = None,
    ) -> list[dict[str, Any]]:
        response = self._get("/v1/track/recommendation", build_recommendation_params(seeds, size, target_features or {}))
        return _content_list(response)

    def get_audio_features(self, track_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not track_ids:
            return {}
        response = self._get("/v1/audio-features", {"ids": track_ids})
        features: dict[str, dict[str, Any]] = {}
        for item in _content_list(response):
            track_id = item.get("id")
            if isinstance(track_id, str):
                features[track_id] = item
        return features


def complete_target_features(
    profile: dict[str, Any],
    emotions: dict[str, float],
) -> dict[str, float]:
    raw_features = dict(profile.get("target_audio_features") or {})
    fallback = derive_target_features_from_emotions(emotions)
    complete: dict[str, float] = {}
    for key in RECCOBEATS_TARGET_KEYS:
        if key in raw_features:
            complete[key] = _coerce_feature_map({key: raw_features[key]}).get(key, fallback[key])
        else:
            complete[key] = fallback[key]
    return complete


def derive_target_features_from_emotions(emotions: dict[str, float]) -> dict[str, float]:
    def score(*names: str) -> float:
        values = [float(emotions[name]) for name in names if name in emotions]
        return max(values) if values else 0.0

    joy = score("joy", "happiness", "happy")
    excitement = score("excitement", "energy", "energetic")
    calm = score("calm", "relaxed", "relaxation")
    focus = score("focus", "concentration")
    sadness = score("sadness", "loneliness")
    anger = score("anger")
    anxiety = score("anxiety", "stress")
    tired = score("tired", "exhaustion", "fatigue")
    confidence = score("confidence")

    valence = _clamp(0.5 + joy * 0.45 + calm * 0.15 + confidence * 0.1 - sadness * 0.4 - anger * 0.2 - anxiety * 0.15, 0.0, 1.0)
    energy = _clamp(0.35 + excitement * 0.45 + confidence * 0.15 + anger * 0.15 + focus * 0.1 - tired * 0.3 - calm * 0.1, 0.0, 1.0)
    danceability = _clamp(0.25 + energy * 0.45 + valence * 0.25 + joy * 0.2 - focus * 0.1, 0.0, 1.0)
    tempo = round(65.0 + energy * 95.0 + excitement * 10.0 - calm * 10.0)
    popularity = round(_clamp(55.0 + confidence * 10.0 + joy * 5.0 - sadness * 5.0, 35.0, 85.0))
    return {
        "valence": round(valence, 3),
        "danceability": round(danceability, 3),
        "energy": round(energy, 3),
        "tempo": float(_clamp(tempo, 40.0, 220.0)),
        "popularity": float(popularity),
    }


def build_recommendation_params(
    seeds: list[str],
    size: int,
    target_features: dict[str, float],
) -> dict[str, Any]:
    params: dict[str, Any] = {"seeds": seeds, "size": size}
    normalized = _coerce_feature_map(target_features)
    for key in RECCOBEATS_TARGET_KEYS:
        if key in normalized:
            if key in ("tempo", "popularity"):
                params[key] = int(round(normalized[key]))
            else:
                params[key] = normalized[key]
    return params


def resolve_seed_track_ids(
    profile: dict[str, Any],
    recco_client: Any,
    warnings: list[str],
    max_seeds: int = 5,
) -> list[str]:
    seeds: list[str] = []
    fallback_tracks: list[str] = []
    for seed_track in profile.get("seed_tracks", []):
        if _looks_like_recco_id(seed_track):
            seeds.append(seed_track)
            if len(seeds) >= max_seeds:
                return seeds

    for artist_name in profile.get("seed_artists", []):
        try:
            candidates = recco_client.search_artist(artist_name, size=5)
        except Exception as exc:  # Keep partial seed resolution useful.
            warnings.append(f"artist search failed for '{artist_name}': {exc}")
            continue
        artist = select_best_artist_match(artist_name, candidates)
        if not artist or not artist.get("id"):
            warnings.append(f"no artist match for '{artist_name}'")
            continue
        if _normalize_name(artist_name) != _normalize_name(str(artist.get("name", ""))):
            warnings.append(f"weak artist match: '{artist_name}' -> '{artist.get('name')}'")
            continue
        try:
            tracks = recco_client.get_artist_tracks(str(artist["id"]), size=5)
        except Exception as exc:
            warnings.append(f"track lookup failed for '{artist.get('name')}': {exc}")
            continue
        first_added = False
        for track in tracks:
            track_id = track.get("id")
            if not isinstance(track_id, str) or track_id in seeds or track_id in fallback_tracks:
                continue
            if not first_added:
                seeds.append(track_id)
                first_added = True
                if len(seeds) >= max_seeds:
                    return seeds
            else:
                fallback_tracks.append(track_id)
    for track_id in fallback_tracks:
        if track_id not in seeds:
            seeds.append(track_id)
            if len(seeds) >= max_seeds:
                return seeds
    return seeds


def _looks_like_recco_id(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F-]{20,40}", value.strip()))


def normalize_track(
    track: dict[str, Any],
    profile: dict[str, Any],
    warnings: list[str],
    audio_features: dict[str, Any] | None = None,
) -> dict[str, Any]:
    countries = str(track.get("availableCountries") or "")
    country_set = {country.strip().upper() for country in countries.split(",") if country.strip()}
    artists = [
        str(artist.get("name"))
        for artist in track.get("artists", [])
        if isinstance(artist, dict) and artist.get("name")
    ]
    if not artists:
        warnings.append(f"track '{track.get('id')}' has no artist metadata")

    fit_reason = _build_fit_reason(track, profile)
    return {
        "id": track.get("id"),
        "title": track.get("trackTitle"),
        "artists": artists,
        "spotify_url": track.get("href"),
        "duration_ms": track.get("durationMs"),
        "popularity": track.get("popularity") or 0,
        "available_in_preferred_country": any(country in country_set for country in PREFERRED_COUNTRIES),
        "audio_features": audio_features or {},
        "fit_reason": fit_reason,
    }


def _build_fit_reason(track: dict[str, Any], profile: dict[str, Any]) -> str:
    mood = profile.get("mood_label") or "your mood"
    intent = profile.get("listening_intent") or "the moment"
    reasoning = profile.get("reasoning_for_user") or ""
    if reasoning:
        return f"Fits {mood}: {reasoning}"
    return f"Fits {mood} and supports {intent}."


def feature_distance(track: dict[str, Any], target_features: dict[str, float]) -> float:
    audio_features = track.get("audio_features") or {}
    distances: list[float] = []
    for key in ("valence", "danceability", "energy"):
        if key in target_features and isinstance(audio_features.get(key), int | float):
            distances.append(abs(float(audio_features[key]) - float(target_features[key])))
    if "tempo" in target_features and isinstance(audio_features.get("tempo"), int | float):
        distances.append(min(abs(float(audio_features["tempo"]) - float(target_features["tempo"])) / 100.0, 1.0))
    if "popularity" in target_features:
        distances.append(min(abs(float(track.get("popularity") or 0) - float(target_features["popularity"])) / 100.0, 1.0))
    if not distances:
        return 1.0
    return sum(distances) / len(distances)


def _normalized_terms(values: list[str]) -> list[str]:
    return [_normalize_name(value) for value in values if _normalize_name(value)]


def _artist_matches(track: dict[str, Any], terms: list[str]) -> bool:
    normalized_terms = _normalized_terms(terms)
    if not normalized_terms:
        return False
    for artist in track.get("artists", []):
        artist_name = _normalize_name(str(artist))
        if any(term == artist_name or term in artist_name for term in normalized_terms):
            return True
    return False


def apply_preference_filters(
    tracks: list[dict[str, Any]],
    preferences: dict[str, list[str]] | None,
    warnings: list[str],
) -> list[dict[str, Any]]:
    preferences = normalize_preferences(preferences or {})
    avoid_artists = preferences.get("avoid_artists", [])
    if not avoid_artists:
        return tracks

    filtered = [track for track in tracks if not _artist_matches(track, avoid_artists)]
    excluded_count = len(tracks) - len(filtered)
    if excluded_count:
        warnings.append(f"excluded {excluded_count} track(s) by avoid_artists preference")
    return filtered


def _needs_ai_preference_filter(preferences: dict[str, list[str]]) -> bool:
    return bool(preferences.get("preferred_genres") or preferences.get("avoid_genres"))


def _normalize_filter_rejections(raw_rejections: Any) -> dict[str, str]:
    if not isinstance(raw_rejections, list):
        return {}
    rejections: dict[str, str] = {}
    for raw in raw_rejections:
        if not isinstance(raw, dict):
            continue
        track_id = raw.get("id")
        if not isinstance(track_id, str) or not track_id:
            continue
        reason = raw.get("reason")
        rejections[track_id] = str(reason or "does not match preferences")
    return rejections


def apply_ai_preference_filter(
    tracks: list[dict[str, Any]],
    preferences: dict[str, list[str]] | None,
    claude_client: Any,
    situation: str,
    warnings: list[str],
) -> list[dict[str, Any]]:
    preferences = normalize_preferences(preferences or {})
    if not tracks or not _needs_ai_preference_filter(preferences):
        return tracks
    if not hasattr(claude_client, "filter_tracks_by_preferences"):
        warnings.append("AI preference filter unavailable; genre preferences were used only for seed selection")
        return tracks

    decision = claude_client.filter_tracks_by_preferences(situation, preferences, tracks)
    accepted_ids = decision.get("accepted_ids") if isinstance(decision, dict) else []
    if not isinstance(accepted_ids, list):
        raise ModelOutputError("Claude preference filter must return accepted_ids as a list")

    accepted = {str(track_id) for track_id in accepted_ids if str(track_id)}
    rejections = _normalize_filter_rejections(decision.get("rejections") if isinstance(decision, dict) else [])
    filtered = [track for track in tracks if str(track.get("id")) in accepted]
    for track in tracks:
        track_id = str(track.get("id") or "")
        if track_id in accepted:
            continue
        title = str(track.get("title") or track_id or "unknown track")
        reason = rejections.get(track_id, "does not match preferences")
        warnings.append(f"AI preference filter rejected '{title}': {reason}")
    if tracks and not filtered:
        warnings.append("AI preference filter removed all tracks; broaden preferences or try different seed artists")
    return filtered


def dedupe_tracks(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for track in tracks:
        track_id = track.get("id")
        if not isinstance(track_id, str) or track_id in seen:
            continue
        seen.add(track_id)
        unique.append(track)
    return unique


def track_reliability_score(
    track: dict[str, Any],
    target_features: dict[str, float],
    preferences: dict[str, list[str]] | None = None,
) -> float:
    preferences = normalize_preferences(preferences or {})
    availability_bonus = 0.2 if track.get("available_in_preferred_country") else 0.0
    fit_score = 1.0 - feature_distance(track, target_features)
    popularity_score = min(float(track.get("popularity") or 0) / 100.0, 1.0)
    preferred_artist_bonus = 0.12 if _artist_matches(track, preferences.get("preferred_artists", [])) else 0.0
    return (fit_score * 0.65) + (popularity_score * 0.15) + availability_bonus + preferred_artist_bonus


def rank_tracks(
    tracks: list[dict[str, Any]],
    target_features: dict[str, float] | None = None,
    preferences: dict[str, list[str]] | None = None,
) -> list[dict[str, Any]]:
    target_features = target_features or {}
    return sorted(
        tracks,
        key=lambda track: (
            track_reliability_score(track, target_features, preferences),
            int(track.get("popularity") or 0),
        ),
        reverse=True,
    )


def recommend_music(
    situation: str,
    emotions: dict[str, float],
    limit: int = 10,
    *,
    preferences: dict[str, list[str]] | None = None,
    claude_client: Any | None = None,
    recco_client: Any | None = None,
) -> dict[str, Any]:
    validate_inputs(situation, emotions, limit)
    preferences = normalize_preferences(preferences or {})
    warnings: list[str] = []
    claude = claude_client or AnthropicMoodClient()
    recco = recco_client or ReccoBeatsClient()

    profile = build_mood_profile(situation, emotions, claude, preferences)
    target_features = complete_target_features(profile, emotions)
    profile["target_audio_features"] = target_features
    seeds = resolve_seed_track_ids(profile, recco, warnings)
    if not seeds:
        raise ReccoBeatsError("Could not resolve any ReccoBeats seed tracks")

    recommendation_size = min(max(limit * 4, limit), 50)
    seed_tracks: list[dict[str, Any]] = []
    if hasattr(recco, "get_tracks"):
        try:
            seed_tracks = recco.get_tracks(seeds)
        except Exception as exc:
            warnings.append(f"seed track lookup failed: {exc}")
    raw_tracks = recco.get_recommendations(seeds, recommendation_size, target_features)
    raw_tracks = dedupe_tracks(seed_tracks + raw_tracks)
    track_ids = [str(track["id"]) for track in raw_tracks if isinstance(track.get("id"), str)]
    audio_features = recco.get_audio_features(track_ids)
    normalized = [
        normalize_track(track, profile, warnings, audio_features.get(str(track.get("id")), {}))
        for track in raw_tracks
    ]
    filtered = apply_preference_filters(normalized, preferences, warnings)
    filtered = apply_ai_preference_filter(filtered, preferences, claude, situation, warnings)
    ranked = rank_tracks(filtered, target_features, preferences)[:limit]

    return {
        "mood_profile": profile,
        "recommendations": ranked,
        "sources": {
            "claude_model": getattr(claude, "model", "injected-client"),
            "reccobeats_base_url": getattr(recco, "base_url", "injected-client"),
            "seed_track_ids": seeds,
            "reccobeats_target_params": target_features,
            "preferences": preferences,
        },
        "warnings": warnings,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recommend songs from a situation and 0.0-1.0 emotion scores."
    )
    parser.add_argument("--situation", required=True, help="Current scene or situation text.")
    parser.add_argument(
        "--emotion",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="Emotion score from 0.0 to 1.0. Repeat for multiple emotions.",
    )
    parser.add_argument("--limit", type=int, default=10, help="Number of recommendations, 1-25.")
    parser.add_argument(
        "--preferences",
        default="",
        help=(
            "Optional JSON object with preferred_genres, avoid_genres, "
            "preferred_artists, and avoid_artists."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        emotions = parse_emotion_args(args.emotion)
        preferences = parse_preferences_text(args.preferences)
        result = recommend_music(args.situation, emotions, args.limit, preferences=preferences)
    except (ValueError, ConfigurationError, ModelOutputError, ReccoBeatsError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
