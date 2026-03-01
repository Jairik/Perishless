# All functions and configurations regarding the Firestore Database document store
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import firebase_admin
from firebase_admin import credentials, firestore

# Authenticate with Firebase using the service account key JSON file
_KEY_PATH = os.path.join(os.path.dirname(__file__), "perishless-3c73c-firebase-adminsdk-fbsvc-17d12425cf.json")
cred = credentials.Certificate(_KEY_PATH)
firebase_admin.initialize_app(cred)

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
    # --- Expiry check: expired items cannot be donated ---
    expiry = item_data.get("expiry_date")
    if expiry is not None:
        if isinstance(expiry, str):
            try:
                expiry = datetime.fromisoformat(expiry)
            except ValueError:
                expiry = None
        if expiry is not None:
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry <= datetime.now(timezone.utc):
                return False

    # --- Storage / packaging: refrigerated or frozen items are not suitable ---
    storage_tags = item_data.get("storage_tags") or []
    if isinstance(storage_tags, str):
        storage_tags = [storage_tags]
    non_donatable_storage = {"refrigerate", "refrigerated", "frozen", "freeze", "keep-refrigerated", "keep-frozen"}
    if any(tag.lower().replace(" ", "-") in non_donatable_storage for tag in storage_tags):
        return False

    packaging_tags = item_data.get("packaging_tags") or []
    if isinstance(packaging_tags, str):
        packaging_tags = [packaging_tags]
    # Sealed shelf-stable packaging strongly suggests the item can be donated
    donatable_packaging = {"can", "canned", "jar", "tetra-pak", "tetra_pak", "box", "carton", "pouch", "sealed", "vacuum"}
    if any(tag.lower() in donatable_packaging for tag in packaging_tags):
        return True

    # --- Category heuristics ---
    category = (item_data.get("category") or "").lower()
    donatable_categories = {
        "canned", "pantry", "dry", "cereal", "pasta", "rice", "grain", "bean",
        "legume", "flour", "sugar", "oil", "soup", "sauce", "condiment", "spice",
        "seasoning", "snack", "cracker", "cookie", "biscuit", "jam", "jelly",
        "peanut-butter", "nut-butter", "coffee", "tea", "beverage", "juice",
        "shelf-stable", "non-perishable",
    }
    non_donatable_categories = {
        "fresh", "produce", "meat", "seafood", "dairy", "milk", "cheese", "egg",
        "refrigerated", "frozen", "deli", "bakery", "prepared",
    }
    if any(kw in category for kw in non_donatable_categories):
        return False
    if any(kw in category for kw in donatable_categories):
        return True

    # --- Perishable indicators on the item itself ---
    if item_data.get("contains_meat"):
        return False
    if item_data.get("contains_dairy"):
        return False

    # Not enough information to decide
    return None


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