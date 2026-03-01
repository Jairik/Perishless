# Main entry point for the FastAPI backend, where all API endpoints are defined and implemented
import asyncio
import base64
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from docstore import create_user, add_food_item, get_food_items, delete_food_item, consume_food_item, trash_food_item, get_history_items, add_favorited_recipe, remove_favorited_recipe, get_favorited_recipes, update_item_image
from oof import get_product_info, find_products_by_name
from lm import generate_recipe_recommendation, generate_expiry_recipe, gemini_chat_response, fill_item_details_from_name, generate_perishthreats, parse_receipt_items, analyze_health_impacts, generate_daily_motivational_quote
from scan_doc import detect_barcode, ocr_receipt
from rdb import ensure_autocomplete_table, autocomplete_food_items, upsert_food_name, update_product_image, find_barcode_by_name
from tts import text_to_speech, speech_to_text

# Server-side pantry cache keyed by uuid — avoids redundant Firestore reads
_pantry_cache: dict[str, list] = {}

def _get_pantry(uuid: str) -> list:
    """Return cached pantry items, fetching from Firestore on a cache miss."""
    if uuid not in _pantry_cache:
        _pantry_cache[uuid] = get_food_items(uuid) or []
    return _pantry_cache[uuid]

def _invalidate_pantry(uuid: str) -> None:
    """Evict a user's pantry from the cache so the next read fetches fresh data."""
    _pantry_cache.pop(uuid, None)

app = FastAPI(title="Perishless_API")


@app.on_event("startup")
async def _startup() -> None:
    """Initialise the relational DB autocomplete table on server start."""
    try:
        await run_in_threadpool(ensure_autocomplete_table)
    except Exception as exc:
        # Don't crash the whole server if the RDB is unavailable
        print(f"[rdb] autocomplete table init failed: {exc}")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health check
@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Get all food items for the given user uuid, optionally filtered by category or days until expiry
@app.get("/api/items/{uuid}")
async def get_items(uuid: str, category: str | None = None, days_until_expiry: int | None = None):
    items = _get_pantry(uuid)
    if category:
        items = [i for i in items if i.get("category") == category]
    if days_until_expiry is not None:
        from datetime import datetime, timezone, timedelta
        cutoff = datetime.now(timezone.utc) + timedelta(days=days_until_expiry)
        items = [i for i in items if i.get("expiry_date") and i["expiry_date"] <= cutoff]

    # Enrich items that have a barcode but no image — concurrent OOF lookups, write-back to Firestore
    async def _enrich_item(item: dict) -> dict:
        if item.get("image_url"):
            return item
        # Resolve barcode: use stored one, or fall back to products-table name lookup
        barcode = item.get("barcode")
        if not barcode:
            try:
                barcode = await asyncio.wait_for(
                    run_in_threadpool(find_barcode_by_name, item.get("name", "")),
                    timeout=2.0,
                )
            except Exception:
                barcode = None
        if not barcode:
            return item
        try:
            info = await asyncio.wait_for(
                run_in_threadpool(get_product_info, barcode),
                timeout=4.0,
            )
            img = info.get("image_url") if info else None
            if img:
                asyncio.create_task(asyncio.to_thread(
                    update_item_image, uuid, item["item_id"], img
                ))
                # Also update the in-memory pantry cache so subsequent reads are instant
                for cached in _pantry_cache.get(uuid, []):
                    if cached.get("item_id") == item["item_id"]:
                        cached["image_url"] = img
                        if barcode and not cached.get("barcode"):
                            cached["barcode"] = barcode
                        break
                return {**item, "image_url": img, "barcode": barcode}
        except Exception:
            pass
        return item

    items = list(await asyncio.gather(*[_enrich_item(i) for i in items]))
    return items


async def _enrich_all_pantry_bg(uuid: str) -> None:
    """Background task: enrich ALL pantry items that are missing images."""
    try:
        all_items = await run_in_threadpool(get_food_items, uuid)
        missing = [i for i in all_items if not i.get("image_url")]
        if not missing:
            return
        async def _do(item: dict) -> None:
            barcode = item.get("barcode")
            if not barcode:
                try:
                    barcode = await asyncio.wait_for(
                        run_in_threadpool(find_barcode_by_name, item.get("name", "")),
                        timeout=2.0,
                    )
                except Exception:
                    barcode = None
            if not barcode:
                return
            try:
                info = await asyncio.wait_for(
                    run_in_threadpool(get_product_info, barcode),
                    timeout=5.0,
                )
                img = info.get("image_url") if info else None
                if img:
                    await asyncio.to_thread(update_item_image, uuid, item["item_id"], img)
                    for cached in _pantry_cache.get(uuid, []):
                        if cached.get("item_id") == item["item_id"]:
                            cached["image_url"] = img
                            break
            except Exception:
                pass
        await asyncio.gather(*[_do(i) for i in missing])
    except Exception:
        pass


# Add a new food item to the database given a barcode image, scoped to the user uuid
@app.post("/api/items/{uuid}/barcode")
async def add_item_by_barcode(uuid: str, image: UploadFile = File(...)):
    image_bytes = await image.read()
    barcode = detect_barcode(image_bytes)
    if not barcode:
        return {"status": "error", "message": "No barcode detected in image"}
    product_info = get_product_info(barcode)
    if product_info:
        add_food_item(uuid, {**product_info, "barcode": barcode})
        _invalidate_pantry(uuid)
        asyncio.create_task(_enrich_all_pantry_bg(uuid))
        try:
            await run_in_threadpool(
                upsert_food_name,
                product_info.get("name"),
                product_info.get("category"),
                product_info.get("image_url"),
            )
        except Exception:
            pass
        return {"status": "success"}
    else:
        return {"status": "error", "message": "Product not found"}


class AddItemRequest(BaseModel):
    name: str
    category: str | None = None
    expiry_date: str | None = None  # ISO 8601 date string, e.g. "2026-03-15" or "2026-03-15T00:00:00Z"
    image_url: str | None = None
    barcode: str | None = None

# Add a custom food item to the database given its name, category, and expiry date, scoped to the user uuid
@app.post("/api/items/{uuid}")
async def add_item_by_name(uuid: str, body: AddItemRequest):
    expiry_dt: datetime | None = None
    if body.expiry_date:
        try:
            expiry_dt = datetime.fromisoformat(body.expiry_date)
            if expiry_dt.tzinfo is None:
                expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return {"status": "error", "message": "Invalid expiry_date format, expected ISO 8601"}

    item_data = await run_in_threadpool(
        fill_item_details_from_name, body.name, body.category, expiry_dt
    )
    # Use image from the frontend search result if Gemini left it blank
    if body.image_url and not item_data.get("image_url"):
        item_data = {**item_data, "image_url": body.image_url}
    # Fallback: look up image by barcode (uses in-process/Firestore cache — fast for seen barcodes)
    if not item_data.get("image_url") and body.barcode:
        try:
            info = await asyncio.wait_for(
                run_in_threadpool(get_product_info, body.barcode),
                timeout=3.0,
            )
            img = info.get("image_url") if info else None
            if img:
                item_data = {**item_data, "image_url": img}
        except Exception:
            pass
    # Store barcode on the item so future pantry fetches can resolve the image
    if body.barcode:
        item_data = {**item_data, "barcode": body.barcode}
    add_food_item(uuid, item_data)
    _invalidate_pantry(uuid)
    asyncio.create_task(_enrich_all_pantry_bg(uuid))
    return {"status": "success"}


# Delete a food item from the database given its id, scoped to the user uuid
# Pass ?consumed=true to move it to history instead of permanently deleting it
@app.delete("/api/items/{uuid}/{item_id}")
async def delete_item(uuid: str, item_id: str, consumed: bool = False):
    if consumed:
        await run_in_threadpool(consume_food_item, uuid, item_id)
    else:
        await run_in_threadpool(trash_food_item, uuid, item_id)
    _invalidate_pantry(uuid)
    return {"status": "success"}


# Fetch a user's consumption/trash history, newest first
@app.get("/api/history/{uuid}")
async def get_history(uuid: str, limit: int = 300):
    try:
        rows = await run_in_threadpool(get_history_items, uuid, max(1, min(limit, 1000)))
        return {"status": "success", "results": rows}
    except Exception:
        return {"status": "error", "message": "Failed to fetch history.", "results": []}


# Autocomplete endpoint — fast local trigram search against the relational DB
@app.get("/api/autocomplete")
async def autocomplete(q: str = "", limit: int = 10):
    if not q.strip():
        return {"status": "success", "results": []}
    results = await run_in_threadpool(autocomplete_food_items, q, min(limit, 25))

    # For results missing images, kick off background DB enrichment (non-blocking)
    async def _enrich_bg(barcode: str) -> None:
        try:
            info = await asyncio.wait_for(
                run_in_threadpool(get_product_info, barcode),
                timeout=4.0,
            )
            img = info.get("image_url") if info else None
            if img:
                await asyncio.to_thread(update_product_image, barcode, img)
        except Exception:
            pass

    for r in results:
        if not r.get("image_url") and r.get("barcode"):
            asyncio.create_task(_enrich_bg(r["barcode"]))

    return {"status": "success", "results": results}


# Fast image lookup by barcode — checks in-process/Firestore/OOF caches in order
@app.get("/api/image/{barcode}")
async def get_image(barcode: str):
    try:
        info = await asyncio.wait_for(
            run_in_threadpool(get_product_info, barcode),
            timeout=4.0,
        )
        img = info.get("image_url") if info else None
        if img:
            asyncio.create_task(asyncio.to_thread(update_product_image, barcode, img))
        return {"image_url": img}
    except Exception:
        return {"image_url": None}


# Barcode lookup using an item's name (not user-specific)
# Also seeds the autocomplete table with results for future offline suggestions
@app.get("/api/searchItem/{name}")
async def lookup_item(name: str):
    normalized_name = name.strip()
    if not normalized_name:
        return {"status": "success", "results": []}
    results = await run_in_threadpool(find_products_by_name, normalized_name)
    # Seed autocomplete table in the background using found product names
    for r in results:
        try:
            await run_in_threadpool(
                upsert_food_name, r.get("name"), None, r.get("image_url")
            )
        except Exception:
            pass
    return {"status": "success", "results": results}


# Generate a recipe recommendation based on items expiring within the next week, scoped to user uuid
@app.get("/api/recipeRecommendation/{uuid}")
async def recipe_recommendation(uuid: str):
    items = _get_pantry(uuid)
    if not items:
        return {"status": "error", "message": "No pantry items found"}
    recommendation = await run_in_threadpool(generate_recipe_recommendation, items, "strong")
    return {"status": "success", "response": recommendation}


# Generate expiry-prioritised meal suggestions for the PerishThreats page, scoped to user uuid
@app.get("/api/perishthreats/{uuid}")
async def perishthreats(uuid: str, count: int = 2):
    items = _get_pantry(uuid)
    if not items:
        return []
    threats = await run_in_threadpool(generate_perishthreats, items, max(1, min(count, 5)))
    return threats


# Analyze pantry items for potential negative health impacts in batches of 10 (fast model)
@app.get("/api/healthImpacts/{uuid}")
async def health_impacts(uuid: str, offset: int = 0, limit: int = 10):
    items = _get_pantry(uuid)
    total = len(items)

    safe_offset = max(0, offset)
    safe_limit = max(1, min(limit, 10))

    if safe_offset >= total:
        return {
            "status": "success",
            "batch": {
                "offset": safe_offset,
                "size": 0,
                "total": total,
                "next_offset": None,
                "done": True,
            },
            "mental": [],
            "physical": [],
        }

    batch_items = items[safe_offset:safe_offset + safe_limit]
    try:
        impacts = await run_in_threadpool(analyze_health_impacts, batch_items, "fast")
    except Exception:
        return {"status": "error", "message": "Failed to analyze health impacts."}

    next_offset = safe_offset + len(batch_items)
    done = next_offset >= total

    return {
        "status": "success",
        "batch": {
            "offset": safe_offset,
            "size": len(batch_items),
            "total": total,
            "next_offset": None if done else next_offset,
            "done": done,
        },
        "mental": impacts.get("mental", []),
        "physical": impacts.get("physical", []),
    }


class RegenerateThreatsRequest(BaseModel):
    instructions: str | None = None
    count: int = 2


class MoodQuoteRequest(BaseModel):
    score: float


class FavoriteRecipeRequest(BaseModel):
    signature: str | None = None
    recipe: dict[str, Any]


class TTSRequest(BaseModel):
    text: str
    voice_id: str | None = None
    model_id: str = "eleven_multilingual_v2"

# Regenerate PerishThreats with optional custom instructions
@app.post("/api/perishthreats/{uuid}")
async def regenerate_perishthreats(uuid: str, body: RegenerateThreatsRequest):
    items = _get_pantry(uuid)
    if not items:
        return []
    threats = await run_in_threadpool(
        generate_perishthreats, items, max(1, min(body.count, 5)), "strong", body.instructions
    )
    return threats


# Generate a daily motivational quote from a user's self-rated mood score (0-10)
@app.post("/api/moodQuote/{uuid}")
async def mood_quote(uuid: str, body: MoodQuoteRequest):
    score = max(0.0, min(10.0, body.score))
    try:
        quote = await run_in_threadpool(generate_daily_motivational_quote, score, "fast")
        return {"status": "success", "score": score, "quote": quote}
    except Exception:
        return {
            "status": "error",
            "message": "Failed to generate motivational quote.",
            "quote": "One small step today still counts—keep going, you’re doing better than you think.",
        }


# Favorite a recipe for a user
@app.post("/api/favorites/{uuid}")
async def favorite_recipe(uuid: str, body: FavoriteRecipeRequest):
    try:
        item = await run_in_threadpool(add_favorited_recipe, uuid, body.recipe, body.signature)
        return {"status": "success", "item": item}
    except Exception:
        return {"status": "error", "message": "Failed to favorite recipe."}


# Remove a favorited recipe for a user
@app.delete("/api/favorites/{uuid}")
async def unfavorite_recipe(uuid: str, body: FavoriteRecipeRequest):
    try:
        removed = await run_in_threadpool(remove_favorited_recipe, uuid, body.recipe, body.signature)
        return {"status": "success", "removed": removed}
    except Exception:
        return {"status": "error", "message": "Failed to remove favorited recipe."}


# Fetch all favorited recipes for a user, newest first
@app.get("/api/favorites/{uuid}")
async def get_favorites(uuid: str, limit: int = 300):
    try:
        rows = await run_in_threadpool(get_favorited_recipes, uuid, max(1, min(limit, 1000)))
        return {"status": "success", "results": rows}
    except Exception:
        return {"status": "error", "message": "Failed to fetch favorited recipes.", "results": []}


# Convert text to speech audio using ElevenLabs
@app.post("/api/tts")
async def tts(body: TTSRequest):
    cleaned = body.text.strip()
    if not cleaned:
        return {"status": "error", "message": "Text cannot be empty."}
    try:
        audio = await run_in_threadpool(text_to_speech, cleaned, body.voice_id, body.model_id)
        encoded = base64.b64encode(audio).decode("utf-8")
        return {
            "status": "success",
            "mime_type": "audio/mpeg",
            "audio_base64": encoded,
        }
    except Exception:
        return {"status": "error", "message": "Failed to synthesize speech."}


# Convert uploaded speech audio to text using ElevenLabs
@app.post("/api/stt")
async def stt(
    audio: UploadFile = File(...),
    model_id: str = Form("scribe_v1"),
    language_code: str | None = Form(None),
):
    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            return {"status": "error", "message": "Audio file is empty."}

        transcript = await run_in_threadpool(
            speech_to_text,
            audio_bytes,
            audio.filename or "audio.webm",
            audio.content_type or "audio/webm",
            model_id,
            language_code,
        )
        if not transcript:
            return {"status": "error", "message": "No speech recognized."}

        return {"status": "success", "text": transcript}
    except Exception:
        return {"status": "error", "message": "Failed to transcribe speech."}


# Generate a single expiry-prioritised recipe as structured JSON, scoped to user uuid
# Returns: { status, meal, response, "youtube-search", ingredients: [{name, inInventory}] }
@app.get("/api/expiryRecipe/{uuid}")
async def expiry_recipe(uuid: str):
    items = _get_pantry(uuid)
    if not items:
        return {"status": "error", "message": "No pantry items found"}
    data = await run_in_threadpool(generate_expiry_recipe, items)
    return {"status": "success", **data}


# Scan a receipt image, extract food items via OCR + Gemini, and add them all to the pantry
@app.post("/api/scanReceipt/{uuid}")
async def scan_receipt(uuid: str, image: UploadFile = File(...)):
    try:
        image_bytes = await image.read()
        if not image_bytes:
            return {"status": "error", "message": "Please upload a receipt image file."}

        # Step 1: OCR — extract text lines from the receipt image
        try:
            lines = await run_in_threadpool(ocr_receipt, image_bytes)
        except Exception as exc:
            msg = str(exc).lower()
            if "tesseract" in msg:
                return {
                    "status": "error",
                    "message": "Receipt OCR is unavailable on the server (Tesseract not installed).",
                }
            return {"status": "error", "message": "Failed to read receipt text."}

        if not lines:
            return {"status": "error", "message": "No text detected in the receipt image."}

        # Step 2: Use Gemini to identify food product names from the OCR output
        try:
            item_names = await run_in_threadpool(parse_receipt_items, lines, "strong")
        except Exception:
            return {"status": "error", "message": "Failed to parse receipt items with AI."}

        if not item_names:
            return {"status": "error", "message": "No food items recognised in the receipt."}

        # Step 3: Concurrently fill in item details (category, expiry estimate, nutrition, etc.)
        async def _fill(name: str) -> dict:
            return await run_in_threadpool(fill_item_details_from_name, name)

        try:
            item_details_list = await asyncio.gather(*[_fill(n) for n in item_names])
        except Exception:
            return {"status": "error", "message": "Failed to enrich receipt items."}

        # Step 4: Persist all items to Firestore; seed autocomplete table in the background
        for item_data in item_details_list:
            try:
                add_food_item(uuid, item_data)
                asyncio.create_task(run_in_threadpool(
                    upsert_food_name, item_data.get("name"), item_data.get("category"), None
                ))
            except Exception:
                continue

        _invalidate_pantry(uuid)
        added_names = [d["name"] for d in item_details_list if isinstance(d, dict) and d.get("name")]
        return {"status": "success", "items": added_names, "count": len(added_names)}
    except Exception:
        return {"status": "error", "message": "Receipt scan failed unexpectedly."}


# Gemini chat request (user-specific for personalized reccomendations based on pantry)
@app.post("/api/lm/{uuid}/{message}")
async def gemini_chat(uuid: str, message: str, tier: str = "fast"):
    pantry = _get_pantry(uuid)
    response = await run_in_threadpool(gemini_chat_response, message, tier, pantry)
    return {"status": "success", "response": response, "model_tier": tier}


# Gemini chat request (compat endpoint for existing frontend)
@app.post("/api/llm/{message}")
async def gemini_chat_compat(message: str, tier: str = "fast"):
    response = await run_in_threadpool(gemini_chat_response, message, tier, None)
    return {"status": "success", "response": response, "model_tier": tier}

# Make a new user in the database given a uuid
@app.post("/api/createUser/{uuid}")
async def create_new_user(uuid: str):
    create_user(uuid)

# Entry point
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
