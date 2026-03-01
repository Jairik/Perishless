# Funny name, used to hold all information about Open Food Facts API interactions, and any related data processing
import functools
import httpx

# Shared persistent client — reuses TCP connections across all requests (avoids TLS handshake on every call)
_client = httpx.Client(
    timeout=httpx.Timeout(connect=3.0, read=8.0, write=5.0, pool=3.0),
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
    headers={"User-Agent": "Perishless/1.0"},
)

# OOF v2 REST endpoints
_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product/{barcode}"
_SEARCH_URL  = "https://world.openfoodfacts.org/cgi/search.pl"

# Only request the fields we need — avoids downloading the full product object (~50–100 KB)
_PRODUCT_FIELDS = ",".join([
    "product_name", "categories_tags",
    "image_front_url", "image_url", "image_nutrition_url",
    "nutriscore_grade", "attribute_groups_en",
    "ecoscore_score", "allergens", "ingredients_text",
    "nova_group", "additives_n", "storage_conditions_tags", "packaging_tags",
])
_SEARCH_FIELDS = "product_name,image_front_thumb_url,image_front_small_url,image_front_url"

def _https(url: str | None) -> str | None:
    """Ensure an image URL uses HTTPS so browsers don't block mixed content."""
    if not url:
        return None
    return "https://" + url[7:] if url.startswith("http://") else url

# In-process barcode cache (layer 1 — fastest, lives for the duration of the server process)
_barcode_cache: dict[str, dict] = {}

def get_product_info(barcode: str):
    # Layer 1: in-process memory cache
    if barcode in _barcode_cache:
        return _barcode_cache[barcode]

    # Layer 2: Firestore persistent cache (survives server restarts)
    try:
        from docstore import db
        cached = db.collection("product_cache").document(barcode).get()
        if cached.exists:
            result = cached.to_dict()
            _barcode_cache[barcode] = result
            return result
    except Exception as e:
        print(f"Firestore cache read error: {e}")

    # Layer 3: Live OOF API call (direct httpx — controllable timeout, connection reuse)
    try:
        r = _client.get(
            _PRODUCT_URL.format(barcode=barcode),
            params={"fields": _PRODUCT_FIELDS},
        )
        r.raise_for_status()
        payload = r.json()
        if payload.get("status") != 1:
            return None
        data = payload.get("product", {})

        # Helper function to get the match value for a given attribute ID
        def get_attr_match(attr_id):
            for group in data.get("attribute_groups_en", []):
                for attr in group.get("attributes", []):
                    if attr.get("id") == attr_id:
                        return attr.get("match")
            return None

        categories = data.get("categories_tags", [])

        result = {
            # General product information
            "name": data.get("product_name", "Unknown"),
            "category": categories[0].split(":")[-1] if categories else "Unknown",
            "image_url": _https(data.get("image_front_url") or data.get("image_url")),
            "nutrition_url": data.get("image_nutrition_url"),
            "nutriscore_grade": data.get("nutriscore_grade", "Unknown").upper(),
            # Information for query matching
            "vegan_match": get_attr_match("vegan"),
            "vegetarian_match": get_attr_match("vegetarian"),
            "ecoscore": data.get("ecoscore_score", "Unknown"),
            "allergens": data.get("allergens", "Unknown"),
            "low_sugar_match": get_attr_match("low-sugar"),
            "low_salt_match": get_attr_match("low-salt"),
            "low_fat_match": get_attr_match("low-fat"),
            # Perishability stuff for calculations
            "ingredients_text": data.get("ingredients_text", "Unknown"),
            "nova_processing_level": data.get("nova_group"),
            "additives_count": data.get("additives_n"),
            "contains_meat": "meat" in str(categories).lower(),
            "contains_dairy": "milk" in str(categories).lower(),
            "storage_tags": data.get("storage_conditions_tags"),
            "packaging_tags": data.get("packaging_tags"),
        }

        # Populate both cache layers
        _barcode_cache[barcode] = result
        try:
            from docstore import db
            db.collection("product_cache").document(barcode).set(result)
        except Exception as e:
            print(f"Firestore cache write error: {e}")

        return result

    except Exception as e:
        print(f"Error fetching product info: {e}")
        return None


# Direct HTTP search with field projection — faster than the library wrapper
@functools.lru_cache(maxsize=256)
def find_products_by_name(name: str):
    normalized_name = " ".join(name.strip().lower().split())
    if not normalized_name:
        return []
    try:
        r = _client.get(
            _SEARCH_URL,
            params={
                "search_terms": normalized_name,
                "search_simple": 1,
                "action": "process",
                "json": 1,
                "page_size": 5,
                "fields": _SEARCH_FIELDS,
            },
        )
        r.raise_for_status()
        return [
            {
                "name": p["product_name"],
                "image_url": _https(p.get("image_front_thumb_url") or p.get("image_front_small_url") or p.get("image_front_url")),
            }
            for p in r.json().get("products", [])
            if p.get("product_name")
        ]
    except Exception as e:
        print(f"Search error: {e}")
        return []
