"""Core text-to-speech and speech-to-text helpers using ElevenLabs APIs."""

from __future__ import annotations

import os
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv()

_ELEVEN_LABS_API_KEY = os.getenv("ELEVEN_LABS_API_KEY")
_ELEVEN_LABS_BASE_URL = "https://api.elevenlabs.io/v1"

# A stable default English voice; caller may override via API.
_DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"


def _require_api_key() -> str:
	if not _ELEVEN_LABS_API_KEY:
		raise RuntimeError("ELEVEN_LABS_API_KEY is not set")
	return _ELEVEN_LABS_API_KEY


def text_to_speech(
	text: str,
	voice_id: str | None = None,
	model_id: str = "eleven_multilingual_v2",
) -> bytes:
	"""Convert plain text into speech audio bytes (mp3)."""
	api_key = _require_api_key()
	cleaned = text.strip()
	if not cleaned:
		raise ValueError("text is empty")

	chosen_voice = (voice_id or _DEFAULT_VOICE_ID).strip()
	if not chosen_voice:
		chosen_voice = _DEFAULT_VOICE_ID

	url = f"{_ELEVEN_LABS_BASE_URL}/text-to-speech/{chosen_voice}"
	headers = {
		"xi-api-key": api_key,
		"Accept": "audio/mpeg",
		"Content-Type": "application/json",
	}
	payload: dict[str, Any] = {
		"text": cleaned,
		"model_id": model_id,
		"voice_settings": {
			"stability": 0.45,
			"similarity_boost": 0.8,
		},
	}

	response = requests.post(url, headers=headers, json=payload, timeout=45)
	response.raise_for_status()
	return response.content


def speech_to_text(
	audio_bytes: bytes,
	filename: str = "audio.webm",
	mime_type: str = "audio/webm",
	model_id: str = "scribe_v1",
	language_code: str | None = None,
) -> str:
	"""Transcribe speech audio bytes into plain text."""
	api_key = _require_api_key()
	if not audio_bytes:
		raise ValueError("audio is empty")

	url = f"{_ELEVEN_LABS_BASE_URL}/speech-to-text"
	headers = {"xi-api-key": api_key}

	files = {
		"file": (filename or "audio.webm", audio_bytes, mime_type or "audio/webm"),
	}
	data: dict[str, str] = {"model_id": model_id}
	if language_code:
		data["language_code"] = language_code

	response = requests.post(url, headers=headers, files=files, data=data, timeout=60)
	response.raise_for_status()

	payload: dict[str, Any] = response.json() if response.content else {}
	transcript = (
		payload.get("text")
		or payload.get("transcript")
		or payload.get("result")
		or ""
	)
	return str(transcript).strip()