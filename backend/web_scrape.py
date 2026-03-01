# Web scraper for images and youtube videos
from __future__ import annotations
import os
import requests
from typing import Any
from dotenv import load_dotenv

load_dotenv()

_YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
_PEXELS_API_KEY = os.getenv("PEXELS_API_KEY")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def get_youtube_cooking_video(search_string: str) -> dict[str, Any] | None:
    """Return the first YouTube cooking video matching the search string via the YouTube Data API v3.

    Args:
        search_string: The meal or recipe to search for (e.g. the youtube-search value from generate_expiry_recipe).

    Returns:
        Dict with keys: video_id, url, title, thumbnail — or None if nothing was found.

    Requires:
        YOUTUBE_API_KEY environment variable set to a valid YouTube Data API v3 key.
    """
    if not _YOUTUBE_API_KEY:
        raise RuntimeError("YOUTUBE_API_KEY is not set")

    query = f"{search_string} recipe cooking"
    try:
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": query,
                "type": "video",
                "videoCategoryId": "26",  # category 26 = Howto & Style (cooking content)
                "maxResults": 5,
                "key": _YOUTUBE_API_KEY,
            },
            timeout=8,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    for item in data.get("items", []):
        video_id = item.get("id", {}).get("videoId")
        if not video_id:
            continue
        snippet = item.get("snippet", {})
        title = snippet.get("title", "")
        thumbnail = (
            snippet.get("thumbnails", {})
            .get("high", snippet.get("thumbnails", {}).get("default", {}))
            .get("url", "")
        )
        return {
            "video_id": video_id,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "title": title,
            "thumbnail": thumbnail,
        }

    return None


def get_meal_image(meal_name: str) -> str | None:
    """Return the URL of a Pexels stock photo for the given meal.

    Args:
        meal_name: Name of the dish to look up.

    Returns:
        Direct image URL string, or None if nothing was found.

    Requires:
        PEXELS_API_KEY environment variable set to a valid Pexels API key.
    """
    if not _PEXELS_API_KEY:
        return None

    try:
        resp = requests.get(
            "https://api.pexels.com/v1/search",
            params={"query": meal_name, "per_page": 1, "orientation": "landscape"},
            headers={"Authorization": _PEXELS_API_KEY},
            timeout=8,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    photos = data.get("photos", [])
    if not photos:
        return None

    # Prefer the "large" size (940×650-ish) — good quality without being huge
    return photos[0].get("src", {}).get("large") or photos[0].get("src", {}).get("original")
