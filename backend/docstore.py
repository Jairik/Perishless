# All functions and configurations regarding the Firestore Database document store
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from typing import Any
import firebase_admin
from firebase_admin import credentials, firestore

ALLOWED_POST_TAGS = {"food giveaway", "recipe reccomendation", "misc"}
POST_TAG_ALIASES = {
    "recipe recommendation": "recipe reccomendation",
}
ALLOWED_POST_REACTIONS = {"kind", "love", "celebrate", "support"}

# Authenticate with Firebase using layered credential fallbacks
def _resolve_firebase_key_path() -> str | None:
    """Resolve a usable Firebase service-account JSON path with multiple fallbacks."""
    backend_dir = os.path.dirname(__file__)

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

    path_candidates: list[str] = []

    for candidate in env_candidates:
        if not candidate:
            continue
        candidate = os.path.expanduser(candidate)
        if os.path.isdir(candidate):
            for filename in filename_candidates:
                path_candidates.append(os.path.join(candidate, filename))
        else:
            path_candidates.append(candidate)

    # Local repo and container defaults
    path_candidates.extend([
        os.path.join(backend_dir, "perishless-3c73c-firebase-adminsdk-fbsvc-17d12425cf.json"),
        os.path.join(backend_dir, "firebase.json"),
        "/app/perishless-3c73c-firebase-adminsdk-fbsvc-17d12425cf.json",
        "/app/firebase.json",
    ])

    # De-duplicate while preserving order
    seen: set[str] = set()
    for candidate in path_candidates:
        normalized = os.path.abspath(candidate)
        if normalized in seen:
            continue
        seen.add(normalized)
        if os.path.isfile(normalized):
            return normalized

    return None


def _initialize_firebase_app() -> None:
    """Initialize Firebase app using the best available credential source."""
    try:
        firebase_admin.get_app()
        return
    except ValueError:
        pass

    key_path = _resolve_firebase_key_path()
    if key_path:
        cred = credentials.Certificate(key_path)
        firebase_admin.initialize_app(cred)
        return

    # Last-resort fallback: Application Default Credentials (ADC)
    try:
        firebase_admin.initialize_app(credentials.ApplicationDefault())
        return
    except Exception as exc:
        raise RuntimeError(
            "Firebase credentials not found. Set FIREBASE_KEY_PATH (file), "
            "or mount a service-account JSON in backend/, /app, or configure "
            "GOOGLE_APPLICATION_CREDENTIALS / ADC."
        ) from exc


_initialize_firebase_app()

# Get a global reference to the Firestore client
db = firestore.client()

# Create a new user collection
def create_user(uuid: str):
    user_ref = db.collection("users").document(uuid)
    user_ref.set({"created_at": firestore.SERVER_TIMESTAMP})
    
# Estimate an approximate expiry date from item attributes when none was provided.
# Returns a timezone-aware datetime or None if there is insufficient data to guess.
def estimate_expiry_date(item_data: dict) -> datetime | None:
    # If an expiry date already exists, don't override it
    if item_data.get("expiry_date") is not None:
        return None

    now = datetime.now(timezone.utc)

    def has_tag(field: str, keywords: set) -> bool:
        tags = item_data.get(field) or []
        if isinstance(tags, str):
            tags = [tags]
        return any(t.lower().replace(" ", "-") in keywords for t in tags)

    category = (item_data.get("category") or "").lower()

    def cat(*keywords: str) -> bool:
        return any(k in category for k in keywords)

    # --- Frozen storage: up to a year ---
    if has_tag("storage_tags", {"frozen", "freeze", "keep-frozen"}) or cat("frozen"):
        return now + timedelta(days=365)

    # --- Hermetically sealed / canned: multi-year ---
    if has_tag("packaging_tags", {"can", "canned", "tin", "jar", "hermetically-sealed", "vacuum"}):
        return now + timedelta(days=730)

    # --- Refrigerated: resolve sub-category first ---
    if has_tag("storage_tags", {"refrigerate", "refrigerated", "keep-refrigerated", "keep-cool"}):
        if cat("seafood", "fish", "shellfish"):
            return now + timedelta(days=3)
        if item_data.get("contains_meat") or cat("meat", "poultry", "chicken", "beef", "pork", "lamb"):
            return now + timedelta(days=4)
        if cat("dairy", "milk", "yogurt", "cream", "butter"):
            return now + timedelta(days=10)
        if cat("cheese"):
            return now + timedelta(days=30)
        if cat("egg"):
            return now + timedelta(days=28)
        if cat("produce", "vegetable", "fruit", "salad", "fresh"):
            return now + timedelta(days=6)
        return now + timedelta(days=10)  # generic refrigerated

    # --- Unrefrigerated category heuristics (ordered most→least perishable) ---
    if cat("seafood", "fish", "shellfish"):
        return now + timedelta(days=3)
    if item_data.get("contains_meat") or cat("meat", "poultry", "deli", "prepared", "ready-to-eat"):
        return now + timedelta(days=4)
    if cat("produce", "vegetable", "fruit", "salad", "fresh"):
        return now + timedelta(days=6)
    if cat("dairy", "milk", "yogurt", "cream") or item_data.get("contains_dairy"):
        return now + timedelta(days=10)
    if cat("cheese"):
        return now + timedelta(days=30)
    if cat("egg"):
        return now + timedelta(days=28)
    if cat("bakery", "bread", "baked"):
        return now + timedelta(days=5)
    if cat("canned", "soup", "sauce", "jam", "jelly", "pickle"):
        return now + timedelta(days=730)
    if cat("pantry", "dry", "cereal", "pasta", "rice", "grain", "bean", "legume",
            "flour", "sugar", "oil", "condiment", "spice", "seasoning",
            "coffee", "tea", "snack", "cracker", "cookie", "biscuit",
            "peanut-butter", "nut-butter", "beverage", "juice"):
        return now + timedelta(days=365)

    # --- NOVA processing level as last heuristic ---
    nova = item_data.get("nova_processing_level")
    if isinstance(nova, int):
        nova_days = {1: 7, 2: 60, 3: 180, 4: 365}
        days = nova_days.get(nova)
        if days:
            return now + timedelta(days=days)

    # --- Generic sealed packaging fallback ---
    if has_tag("packaging_tags", {"box", "carton", "pouch", "sealed", "tetra-pak", "tetra_pak"}):
        return now + timedelta(days=365)

    return None


# Determine if a food item can be donated (e.g. to a canned food drive / food bank)
# based on its stored attributes. Returns True, False, or None if not determinable.
def determine_can_donate(item_data: dict) -> bool | None:
    # --- Expiry check: expired or near-expiry items cannot be donated ---
    now = datetime.now(timezone.utc)
    min_donation_window = now + timedelta(days=90)

    expiry = item_data.get("expiry_date")
    if expiry is not None:
        if isinstance(expiry, str):
            try:
                expiry = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
            except ValueError:
                expiry = None
        if expiry is not None:
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry <= now:
                return False
            # Business rule: do not donate foods that expire within 3 months.
            if expiry <= min_donation_window:
                return False

    # --- Normalize commonly inspected fields ---
    category = (item_data.get("category") or "").lower().strip()
    name = (item_data.get("name") or "").lower().strip()
    ingredients_text = (item_data.get("ingredients_text") or "").lower().strip()

    def text_has_any(text: str, keywords: set[str]) -> bool:
        return any(kw in text for kw in keywords)

    # --- Storage / handling: chilled/frozen/perishable items are not suitable ---
    storage_tags = item_data.get("storage_tags") or []
    if isinstance(storage_tags, str):
        storage_tags = [storage_tags]
    storage_tags_norm = [tag.lower().replace(" ", "-") for tag in storage_tags if isinstance(tag, str)]

    non_donatable_storage = {
        "refrigerate", "refrigerated", "keep-refrigerated", "chilled", "keep-chilled",
        "frozen", "freeze", "keep-frozen", "perishable",
    }
    if any(tag in non_donatable_storage for tag in storage_tags_norm):
        return False

    # --- Packaging integrity: opened/damaged packaging cannot be donated ---
    packaging_tags = item_data.get("packaging_tags") or []
    if isinstance(packaging_tags, str):
        packaging_tags = [packaging_tags]
    packaging_tags_norm = [tag.lower().replace(" ", "-") for tag in packaging_tags if isinstance(tag, str)]

    compromised_packaging = {"opened", "open", "unsealed", "damaged", "leaking", "broken", "torn"}
    if any(tag in compromised_packaging for tag in packaging_tags_norm):
        return False

    # --- Explicit perishables / unsafe classes ---
    non_donatable_food_tokens = {
        "fresh", "raw", "cooked", "ready-to-eat", "leftover", "deli", "prepared",
        "produce", "fruit", "vegetable", "salad", "sprout", "herb",
        "meat", "chicken", "beef", "pork", "lamb", "turkey", "bacon", "ham", "sausage",
        "seafood", "fish", "shellfish", "shrimp", "crab", "lobster",
        "dairy", "milk", "cheese", "yogurt", "cream", "butter",
        "egg", "bakery", "bread", "cake", "pastry", "sandwich",
    }
    if text_has_any(category, non_donatable_food_tokens) or text_has_any(name, non_donatable_food_tokens):
        return False

    # Ingredients-based safety signal for items likely requiring refrigeration.
    non_donatable_ingredient_tokens = {
        "milk", "cream", "yogurt", "butter", "cheese",
        "egg", "ground beef", "chicken", "pork", "fish", "shrimp",
    }
    if ingredients_text and text_has_any(ingredients_text, non_donatable_ingredient_tokens):
        return False

    # --- Category heuristics ---
    donatable_categories = {
        "canned", "pantry", "dry", "cereal", "pasta", "rice", "grain", "bean",
        "legume", "flour", "sugar", "oil", "soup", "sauce", "condiment", "spice",
        "seasoning", "snack", "cracker", "cookie", "biscuit", "jam", "jelly",
        "peanut-butter", "nut-butter", "coffee", "tea", "beverage", "juice",
        "shelf-stable", "non-perishable",
    }
    non_donatable_categories = {
        "fresh", "produce", "meat", "seafood", "dairy", "milk", "cheese", "egg",
        "refrigerated", "frozen", "deli", "bakery", "prepared", "leftover", "ready-to-eat",
    }
    if any(kw in category for kw in non_donatable_categories):
        return False

    # --- Perishable indicators on the item itself ---
    if item_data.get("contains_meat"):
        return False
    if item_data.get("contains_dairy"):
        return False

    # --- Positive allow-list: only clearly shelf-stable sealed products are donatable ---
    donatable_packaging = {
        "can", "canned", "jar", "tetra-pak", "tetra_pak", "box", "carton", "pouch", "sealed", "vacuum"
    }
    has_stable_packaging = any(tag in donatable_packaging for tag in packaging_tags_norm)
    has_donatable_category = any(kw in category for kw in donatable_categories)

    if has_stable_packaging and has_donatable_category:
        return True

    # Conservative default to avoid false-positive donation flags.
    return False


# Add a new food item to the user's collection
def add_food_item(uuid: str, item_data: dict):
    # Estimate expiry from attributes if not already present
    if not item_data.get("expiry_date"):
        estimated = estimate_expiry_date(item_data)
        if estimated:
            item_data = {**item_data, "expiry_date": estimated}
    item_data = {**item_data, "can_donate": determine_can_donate(item_data)}
    items_ref = db.collection("users").document(uuid).collection("items")
    _, doc_ref = items_ref.add(item_data)
    doc_ref.update({"item_id": doc_ref.id})
    
# Get all food items for a user, optionally filtered by category or days until expiry
def get_food_items(uuid: str, category: str | None = None, days_until_expiry: int | None = None):
    items_ref = db.collection("users").document(uuid).collection("items")
    query = items_ref
    if category:
        query = query.where("category", "==", category)
    if days_until_expiry is not None:
        query = query.where("expiry_date", "<=", firestore.SERVER_TIMESTAMP + timedelta(days=days_until_expiry))
    return [{"item_id": doc.id, **doc.to_dict()} for doc in query.stream()]

# Patch the image_url on an existing pantry item (used for background image enrichment)
def update_item_image(uuid: str, item_id: str, image_url: str) -> None:
    try:
        db.collection("users").document(uuid).collection("items").document(item_id).update({"image_url": image_url})
    except Exception:
        pass

# Delete a food item from the user's collection
def delete_food_item(uuid: str, item_id: str):
    item_ref = db.collection("users").document(uuid).collection("items").document(item_id)
    item_ref.delete()


def move_food_item_to_history(uuid: str, item_id: str, action: str) -> bool:
    """Move a pantry item into the user's history collection with an action marker."""
    item_ref = db.collection("users").document(uuid).collection("items").document(item_id)
    item_snap = item_ref.get()
    item_data = item_snap.to_dict() if item_snap.exists else None
    if not item_data:
        return False

    timestamp_field = "consumed_at" if action == "consumed" else "trashed_at"
    history_ref = db.collection("users").document(uuid).collection("history").document(item_id)
    history_ref.set({
        **item_data,
        "history_action": action,
        "history_at": firestore.SERVER_TIMESTAMP,
        timestamp_field: firestore.SERVER_TIMESTAMP,
    })
    item_ref.delete()
    return True
    
# "Consume" a food item, moving it to a "history" collection with a timestamp
def consume_food_item(uuid: str, item_id: str):
    move_food_item_to_history(uuid, item_id, "consumed")


def trash_food_item(uuid: str, item_id: str):
    move_food_item_to_history(uuid, item_id, "trashed")


def get_history_items(uuid: str, limit: int = 300):
    """Return history records for a user, newest first."""
    history_ref = db.collection("users").document(uuid).collection("history")
    query = history_ref.order_by("history_at", direction=firestore.Query.DESCENDING).limit(max(1, limit))
    rows = []
    for doc in query.stream():
        data = doc.to_dict() or {}
        action = data.get("history_action")
        if not action:
            if data.get("trashed_at"):
                action = "trashed"
            elif data.get("consumed_at"):
                action = "consumed"
            else:
                action = "consumed"
        rows.append({"item_id": doc.id, **data, "history_action": action})
    return rows


def _favorite_recipe_doc_id(recipe_data: dict, recipe_signature: str | None = None) -> str:
    """Build a stable Firestore-safe document id for a favorited recipe."""
    if recipe_signature and recipe_signature.strip():
        source = recipe_signature.strip().lower()
    else:
        source = json.dumps(recipe_data or {}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def add_favorited_recipe(uuid: str, recipe_data: dict, recipe_signature: str | None = None) -> dict:
    """Upsert a favorited recipe for the user and return stored record metadata."""
    recipe_data = dict(recipe_data or {})
    recipe_id = _favorite_recipe_doc_id(recipe_data, recipe_signature)
    signature = recipe_signature.strip() if recipe_signature else None
    ref = db.collection("users").document(uuid).collection("favorited_recipes").document(recipe_id)
    ref.set({
        **recipe_data,
        "recipe_signature": signature,
        "favorited_at": firestore.SERVER_TIMESTAMP,
    })
    return {"favorite_id": recipe_id, "recipe_signature": signature, **recipe_data}


def remove_favorited_recipe(uuid: str, recipe_data: dict | None = None, recipe_signature: str | None = None) -> bool:
    """Remove a favorited recipe by signature or recipe payload-derived id."""
    recipe_id = _favorite_recipe_doc_id(recipe_data or {}, recipe_signature)
    ref = db.collection("users").document(uuid).collection("favorited_recipes").document(recipe_id)
    snap = ref.get()
    if not snap.exists:
        return False
    ref.delete()
    return True


def get_favorited_recipes(uuid: str, limit: int = 300):
    """Return favorited recipes newest first."""
    coll = db.collection("users").document(uuid).collection("favorited_recipes")
    query = coll.order_by("favorited_at", direction=firestore.Query.DESCENDING).limit(max(1, limit))
    rows = []
    for doc in query.stream():
        data = doc.to_dict() or {}
        rows.append({"favorite_id": doc.id, **data})
    return rows


def create_post(author_uuid: str, author_name: str, content: str, tag: str, location: str | None = None) -> dict[str, Any]:
    """Create a new global community post."""
    posts_ref = db.collection("posts")
    reaction_counts = {reaction: 0 for reaction in ALLOWED_POST_REACTIONS}
    reaction_users = {reaction: [] for reaction in ALLOWED_POST_REACTIONS}
    payload: dict[str, Any] = {
        "author_uuid": author_uuid,
        "author_name": author_name.strip() or "Anonymous",
        "content": content.strip(),
        "tag": tag,
        "reaction_counts": reaction_counts,
        "reaction_users": reaction_users,
        "kind_users": [],
        "kind_count": 0,
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    if location and location.strip():
        payload["location"] = location.strip()

    _, doc_ref = posts_ref.add(payload)
    doc_ref.update({"post_id": doc_ref.id})
    snap = doc_ref.get()
    return {"post_id": doc_ref.id, **(snap.to_dict() or payload)}


def _normalized_reactions(data: dict[str, Any]) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Read reaction state from a post doc, normalizing legacy and partial payloads."""
    counts: dict[str, int] = {reaction: 0 for reaction in ALLOWED_POST_REACTIONS}
    users: dict[str, list[str]] = {reaction: [] for reaction in ALLOWED_POST_REACTIONS}

    raw_counts = data.get("reaction_counts")
    if isinstance(raw_counts, dict):
        for reaction, value in raw_counts.items():
            if reaction in counts:
                try:
                    counts[reaction] = max(0, int(value))
                except Exception:
                    counts[reaction] = 0

    raw_users = data.get("reaction_users")
    if isinstance(raw_users, dict):
        for reaction, value in raw_users.items():
            if reaction in users and isinstance(value, list):
                normalized = [v for v in value if isinstance(v, str) and v.strip()]
                users[reaction] = list(dict.fromkeys(normalized))

    legacy_kind_users = data.get("kind_users")
    if not users["kind"] and isinstance(legacy_kind_users, list):
        normalized = [v for v in legacy_kind_users if isinstance(v, str) and v.strip()]
        users["kind"] = list(dict.fromkeys(normalized))

    legacy_kind_count = data.get("kind_count")
    if counts["kind"] == 0:
        if isinstance(legacy_kind_count, int) and legacy_kind_count > 0:
            counts["kind"] = legacy_kind_count
        elif users["kind"]:
            counts["kind"] = len(users["kind"])

    for reaction in ALLOWED_POST_REACTIONS:
        counts[reaction] = max(counts[reaction], len(users[reaction]))

    return counts, users


def get_posts(tag: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """Return global posts newest-first, optionally filtered by tag."""
    coll = db.collection("posts")
    query = coll
    if tag and tag != "all":
        query = query.where("tag", "==", tag)
    query = query.order_by("created_at", direction=firestore.Query.DESCENDING).limit(max(1, min(limit, 500)))

    rows: list[dict[str, Any]] = []
    for doc in query.stream():
        data = doc.to_dict() or {}
        reaction_counts, reaction_users = _normalized_reactions(data)
        rows.append({
            "post_id": doc.id,
            **data,
            "reaction_counts": reaction_counts,
            "reaction_users": reaction_users,
            "kind_count": reaction_counts["kind"],
            "kind_users": reaction_users["kind"],
        })
    return rows


def toggle_post_reaction(post_id: str, actor_uuid: str, reaction: str) -> dict[str, Any] | None:
    """Toggle a user's reaction on a post and return updated summary."""
    ref = db.collection("posts").document(post_id)
    snap = ref.get()
    if not snap.exists:
        return None

    reaction_key = (reaction or "").strip().lower()
    if reaction_key not in ALLOWED_POST_REACTIONS:
        raise ValueError("Invalid reaction")

    data = snap.to_dict() or {}
    counts, users = _normalized_reactions(data)

    existing = users[reaction_key]
    if actor_uuid in existing:
        users[reaction_key] = [u for u in existing if u != actor_uuid]
        user_reacted = False
    else:
        users[reaction_key] = [*existing, actor_uuid]
        user_reacted = True

    counts[reaction_key] = len(users[reaction_key])

    ref.update({
        "reaction_counts": counts,
        "reaction_users": users,
        "kind_count": counts["kind"],
        "kind_users": users["kind"],
    })

    return {
        "post_id": post_id,
        "reaction": reaction_key,
        "user_reacted": user_reacted,
        "reaction_count": counts[reaction_key],
        "reaction_counts": counts,
    }


def toggle_post_kind(post_id: str, actor_uuid: str) -> dict[str, Any] | None:
    """Toggle a user's kind interaction on a post and return updated summary."""
    result = toggle_post_reaction(post_id, actor_uuid, "kind")
    if not result:
        return None

    return {
        "post_id": post_id,
        "kind_count": result.get("reaction_count", 0),
        "user_kinded": result.get("user_reacted", False),
    }


def normalize_post_tag(tag: str) -> str | None:
    """Normalize and validate post tags."""
    normalized = (tag or "").strip().lower()
    normalized = POST_TAG_ALIASES.get(normalized, normalized)
    if normalized in ALLOWED_POST_TAGS:
        return normalized
    return None


def list_posts_payload(tag: str = "all", limit: int = 200) -> dict[str, Any]:
    """Return API-ready payload for listing posts with validation."""
    normalized = (tag or "all").strip().lower()
    if normalized != "all":
        normalized = POST_TAG_ALIASES.get(normalized, normalized)
    if normalized != "all" and normalized not in ALLOWED_POST_TAGS:
        return {"status": "error", "message": "Invalid tag filter.", "results": []}

    rows = get_posts(normalized, limit)
    return {"status": "success", "results": rows}


def create_post_payload(uuid: str, author_name: str, content: str, tag: str, location: str | None = None) -> dict[str, Any]:
    """Validate, create, and return API-ready payload for a global post."""
    actor = (uuid or "").strip()
    if not actor:
        return {"status": "error", "message": "Missing user id."}

    cleaned_content = (content or "").strip()
    if not cleaned_content:
        return {"status": "error", "message": "Post content cannot be empty."}

    normalized_tag = normalize_post_tag(tag)
    if not normalized_tag:
        return {"status": "error", "message": "Invalid post tag."}

    cleaned_location = (location or "").strip()
    if normalized_tag == "food giveaway" and not cleaned_location:
        return {"status": "error", "message": "Location is required for food giveaway posts."}

    item = create_post(
        actor,
        (author_name or "").strip() or "Anonymous",
        cleaned_content,
        normalized_tag,
        cleaned_location or None,
    )
    return {"status": "success", "item": item}


def toggle_post_kind_payload(post_id: str, actor_uuid: str) -> dict[str, Any]:
    """Toggle kind interaction and return API-ready payload."""
    actor = (actor_uuid or "").strip()
    if not actor:
        return {"status": "error", "message": "Missing user id."}

    result = toggle_post_kind(post_id, actor)
    if not result:
        return {"status": "error", "message": "Post not found."}
    return {"status": "success", **result}


def toggle_post_reaction_payload(post_id: str, actor_uuid: str, reaction: str) -> dict[str, Any]:
    """Toggle generic post reaction and return API-ready payload."""
    actor = (actor_uuid or "").strip()
    if not actor:
        return {"status": "error", "message": "Missing user id."}

    normalized = (reaction or "").strip().lower()
    if normalized not in ALLOWED_POST_REACTIONS:
        return {"status": "error", "message": "Invalid reaction type."}

    result = toggle_post_reaction(post_id, actor, normalized)
    if not result:
        return {"status": "error", "message": "Post not found."}
    return {"status": "success", **result}