from __future__ import annotations
# Dev just adding stuff in here for POC while nginx and docker is dump

import os
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


DUMMY_POSTS: list[dict[str, str]] = [
    {
        "author_uuid": "demo-user-001",
        "author_name": "Ava (Demo)",
        "content": "Giving away 2 extra loaves of whole wheat bread. Pickup before 7pm today.",
        "tag": "food giveaway",
        "location": "Downtown Library, Main St",
    },
    {
        "author_uuid": "demo-user-002",
        "author_name": "Noah (Demo)",
        "content": "Recipe recommendation: quick fried rice using leftover veggies and day-old rice.",
        "tag": "recipe reccomendation",
    },
]


def resolve_firebase_key_path() -> str:
    backend_dir = Path(__file__).resolve().parent

    env_candidates = [
        os.getenv("FIREBASE_KEY_PATH"),
        os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
        os.getenv("FIREBASE_CREDENTIALS"),
    ]

    filename_candidates = [
        "perishless-3c73c-firebase-adminsdk-fbsvc-17d12425cf.json",
        "firebase.json",
        "service-account.json",
        "serviceAccountKey.json",
    ]

    path_candidates: list[Path] = []

    for candidate in env_candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.is_dir():
            for filename in filename_candidates:
                path_candidates.append(path / filename)
        else:
            path_candidates.append(path)

    path_candidates.extend(
        [
            backend_dir / "perishless-3c73c-firebase-adminsdk-fbsvc-17d12425cf.json",
            backend_dir / "firebase.json",
            Path("/app/perishless-3c73c-firebase-adminsdk-fbsvc-17d12425cf.json"),
            Path("/app/firebase.json"),
        ]
    )

    seen: set[Path] = set()
    for candidate in path_candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_file():
            return str(resolved)

    raise FileNotFoundError(
        "Could not find Firebase service-account JSON. Set FIREBASE_KEY_PATH or place firebase.json in backend/."
    )


def get_firestore_client() -> firestore.Client:
    try:
        firebase_admin.get_app()
    except ValueError:
        key_path = resolve_firebase_key_path()
        firebase_admin.initialize_app(credentials.Certificate(key_path))
    return firestore.client()


def seed_posts(count: int = 2) -> list[str]:
    db = get_firestore_client()
    posts_ref = db.collection("posts")

    reaction_counts = {"kind": 0, "love": 0, "celebrate": 0, "support": 0}
    reaction_users = {"kind": [], "love": [], "celebrate": [], "support": []}

    inserted_ids: list[str] = []
    for idx, base in enumerate(DUMMY_POSTS[: max(1, min(count, 2))], start=1):
        payload: dict[str, object] = {
            "author_uuid": base["author_uuid"],
            "author_name": base["author_name"],
            "content": base["content"],
            "tag": base["tag"],
            "reaction_counts": reaction_counts.copy(),
            "reaction_users": {k: list(v) for k, v in reaction_users.items()},
            "kind_users": [],
            "kind_count": 0,
            "created_at": firestore.SERVER_TIMESTAMP,
            "seeded_demo": True,
            "seeded_at": datetime.now(timezone.utc).isoformat(),
            "seed_batch": f"demo-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
        }
        location = base.get("location")
        if location:
            payload["location"] = location

        _, doc_ref = posts_ref.add(payload)
        doc_ref.update({"post_id": doc_ref.id})
        inserted_ids.append(doc_ref.id)
        print(f"[{idx}] Inserted demo post: {doc_ref.id}")

    return inserted_ids


if __name__ == "__main__":
    inserted = seed_posts(count=2)
    print(f"Done. Inserted {len(inserted)} post(s).")
