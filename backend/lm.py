"""Handles all interactions with Gemini models."""

from __future__ import annotations
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from dotenv import load_dotenv
from google import genai

load_dotenv()

_API_KEY = os.getenv("GEMINI_API_KEY")
_FAST_MODEL = "gemini-2.5-flash-lite"
_STRONG_MODEL = "gemini-2.5-flash"

_client: genai.Client | None = None


def _get_client() -> genai.Client:
	global _client
	if _client is None:
		if not _API_KEY:
			raise RuntimeError("GEMINI_API_KEY is not set")
		_client = genai.Client(api_key=_API_KEY)
	return _client


def _select_model(tier: str) -> str:
	return _STRONG_MODEL if tier == "strong" else _FAST_MODEL


def _format_pantry_items(items: list[dict[str, Any]], max_items: int = 60) -> str:
	"""Format a list of pantry item dicts into a human-readable bullet list for prompts."""
	item_lines: list[str] = []
	for item in items[:max_items]:
		name = str(item.get("name", "")).strip()
		if not name:
			continue
		parts = [name]
		category = item.get("category")
		if category and category != "Unknown":
			parts.append(f"category: {category}")
		expiry = item.get("expiry_date")
		if expiry:
			if isinstance(expiry, datetime):
				days_left = (expiry.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)).days
				parts.append(f"expires in {days_left} day(s)" if days_left >= 0 else "expired")
			else:
				parts.append(f"expiry: {expiry}")
		allergens = item.get("allergens")
		if allergens and allergens != "Unknown":
			parts.append(f"allergens: {allergens}")
		vegan = item.get("vegan_match")
		if vegan is not None:
			parts.append(f"vegan: {vegan}%")
		item_lines.append(f"- {', '.join(parts)}")
	return "\n".join(item_lines)


def gemini_chat_response(message: str, tier: str = "fast", pantry_items: list[dict[str, Any]] | None = None) -> str:
	"""Chat response from Gemini.

	Args:
		message: User prompt.
		tier: "fast" for cheaper/faster model, "strong" for higher-quality model.
		pantry_items: Optional pantry context used to personalize responses.
	"""
	client = _get_client()

	pantry_text = ""
	if pantry_items:
		formatted = _format_pantry_items(pantry_items)
		if formatted:
			pantry_text = "\n\nPantry items:\n" + formatted

	prompt = (
		"You are Carry, a carrot who provides concise food assistant for reducing food waste. "
		"Prefer practical, safe, and budget-friendly advice. Try to avoid too many empty lines in your response."
        "Use the pantry context if relevant, but don't make up details about the items."
		f"{pantry_text}\n\nUser: {message}"
	)
	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	return (response.text or "").strip()


def generate_daily_motivational_quote(mood_score: float, tier: str = "fast") -> str:
	"""Generate a short motivational quote tailored to a user's self-rated daily mood (0-10)."""
	client = _get_client()

	clamped = max(0.0, min(10.0, float(mood_score)))
	prompt = (
		"You are Carry, a supportive and kind carrot assistant. "
		"Given a user's mood score from 0 to 10, write one brief motivational quote for today. "
		"Tone rules: warm, practical, non-judgmental, never preachy. "
		"Keep it to one or two short sentences max. "
		"If mood is low, prioritize encouragement and small achievable steps. "
		"If mood is high, reinforce momentum with grounded positivity. "
		"Do not mention clinical advice, diagnosis, or therapy directives. "
		"Return plain text only (no markdown, no bullet points, no labels).\n\n"
		f"Mood score: {clamped:.1f}/10"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	text = (response.text or "").strip()
	if not text:
		return "One small step today still counts—keep going, you’re doing better than you think."
	return text


def generate_recipe_recommendation(items: list[dict[str, Any]], tier: str = "strong") -> str:
	"""Generate a plain-text recipe recommendation that uses soon-to-expire pantry items.

	Args:
		items: List of pantry item dicts.
		tier: "fast" or "strong" model tier.

	Returns:
		A friendly markdown-formatted recipe recommendation as a string.
	"""
	client = _get_client()
	sorted_items = _sort_by_expiry(items)
	formatted = _format_pantry_items(sorted_items, max_items=60)

	prompt = (
		"You are Carry, a friendly food waste reduction assistant. Under no circumstances should you suggest recipes that are unsafe or impractical."
		"Based on the pantry items below (listed soonest-expiring first), suggest a practical recipe "
		"that uses as many of these ingredients as possible to minimise waste. "
		"Keep the response concise, friendly, and formatted with markdown (use bold for the recipe name, "
		"a short ingredients list, and step-by-step instructions). Try to avoid too many empty lines.\n\n"
		"Pantry items:\n"
		f"{formatted}"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	return (response.text or "").strip()


def fill_item_details_from_name(
	name: str,
	category: str | None = None,
	expiry_date: datetime | None = None,
	tier: str = "fast",
) -> dict[str, Any]:
	"""Use Gemini to fill in food item details from just the item name.

	Returns a dict matching the Firestore food item schema.
	"""
	client = _get_client()

	known_fields = f"Name: {name}"
	if category:
		known_fields += f"\nCategory: {category}"
	if expiry_date:
		known_fields += f"\nExpiry date: {expiry_date.isoformat()}"

	prompt = (
		"You are a food database assistant. Given the following food item information, "
		"fill in the remaining details as accurately as possible.\n\n"
		f"{known_fields}\n\n"
		"Return ONLY a valid JSON object with exactly these fields (no markdown, no explanation):\n"
		"{\n"
		'  "category": "<food category if not provided, e.g. dairy, produce, meat, pantry>",\n'
		'  "typical_shelf_days": <integer days from purchase until expiry if expiry not provided, else null>,\n'
		'  "nutriscore_grade": "<A/B/C/D/E or Unknown>",\n'
		'  "vegan_match": <0-100 confidence this is vegan, or null>,\n'
		'  "vegetarian_match": <0-100 confidence this is vegetarian, or null>,\n'
		'  "ecoscore": <0-100 eco score estimate, or null>,\n'
		'  "allergens": "<comma-separated common allergens, or Unknown>",\n'
		'  "low_sugar_match": <0-100 or null>,\n'
		'  "low_salt_match": <0-100 or null>,\n'
		'  "low_fat_match": <0-100 or null>,\n'
		'  "ingredients_text": "<typical ingredients, or Unknown>",\n'
		'  "nova_processing_level": <1-4 integer, or null>,\n'
		'  "additives_count": <integer estimate, or null>,\n'
		'  "contains_meat": <true or false>,\n'
		'  "contains_dairy": <true or false>\n'
		"}"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	text = (response.text or "").strip()

	# Strip markdown code fences if present
	if text.startswith("```"):
		parts = text.split("```")
		text = parts[1] if len(parts) > 1 else ""
		if text.startswith("json"):
			text = text[4:]
	text = text.strip()

	try:
		data: dict[str, Any] = json.loads(text)
	except json.JSONDecodeError:
		data = {}

	# Resolve expiry_date: Gemini shelf-life estimate first, rule-based fallback second
	if expiry_date is None:
		shelf_days = data.get("typical_shelf_days")
		if isinstance(shelf_days, int) and shelf_days > 0:
			expiry_date = datetime.now(timezone.utc) + timedelta(days=shelf_days)

	if expiry_date is None:
		# Gemini didn't provide a shelf-life estimate — use rule-based heuristics
		from docstore import estimate_expiry_date
		expiry_date = estimate_expiry_date({
			"category":              category or data.get("category"),
			"contains_meat":         bool(data.get("contains_meat", False)),
			"contains_dairy":        bool(data.get("contains_dairy", False)),
			"nova_processing_level": data.get("nova_processing_level"),
			"storage_tags":          data.get("storage_tags"),
			"packaging_tags":        data.get("packaging_tags"),
		})

	return {
		"name": name,
		"category": category or data.get("category", "Unknown"),
		"image_url": None,
		"nutrition_url": None,
		"nutriscore_grade": data.get("nutriscore_grade", "Unknown"),
		"vegan_match": data.get("vegan_match"),
		"vegetarian_match": data.get("vegetarian_match"),
		"ecoscore": data.get("ecoscore"),
		"allergens": data.get("allergens", "Unknown"),
		"low_sugar_match": data.get("low_sugar_match"),
		"low_salt_match": data.get("low_salt_match"),
		"low_fat_match": data.get("low_fat_match"),
		"ingredients_text": data.get("ingredients_text", "Unknown"),
		"nova_processing_level": data.get("nova_processing_level"),
		"additives_count": data.get("additives_count"),
		"contains_meat": bool(data.get("contains_meat", False)),
		"contains_dairy": bool(data.get("contains_dairy", False)),
		"storage_tags": None,
		"packaging_tags": None,
		"expiry_date": expiry_date,
	}


def generate_perishthreats(items: list[dict[str, Any]], count: int = 2, tier: str = "strong", instructions: str | None = None) -> list[dict[str, Any]]:
	"""Generate *count* meal suggestions that defeat expiring pantry items.

	Returns a list of dicts shaped for the PerishThreats frontend page:
	  meal_type        - name of the dish
	  description      - one-sentence teaser
	  youtube_search   - plain-text YouTube search query for this dish
	  ingredients      - list of {name, in_inventory, expiry_date, image_url}
	"""
	client = _get_client()

	sorted_items = _sort_by_expiry(items)
	inventory_map: dict[str, dict[str, Any]] = {
		str(i.get("name", "")).strip().lower(): i
		for i in sorted_items if i.get("name")
	}
	formatted = _format_pantry_items(sorted_items, max_items=80)

	custom_note = f"\n\nAdditional instructions from the user: {instructions.strip()}" if instructions and instructions.strip() else ""

	prompt = (
		"You are a food waste reduction assistant. "
		f"Given the pantry below (listed soonest-expiring first), suggest exactly {count} practical "
		"recipes that use as many expiring items as possible. "
		"You may include a small number of staple pantry items not in the list.\n\n"
		"Pantry items:\n"
		f"{formatted}{custom_note}\n\n"
		"Return ONLY a valid JSON array (no markdown, no explanation) with exactly these fields per element:\n"
		"[\n"
		"  {\n"
		'    "meal_type": "<name of the dish>",\n'
        '    "calories": <estimated calories for the whole dish>,\n'
		'    "description": "<one compelling sentence about why this recipe fights food waste>",\n'
		'    "youtube_search": "<short YouTube search query someone would type to find a recipe video for this dish>",\n'
		'    "ingredients": [\n'
		'      {"name": "<ingredient>", "in_inventory": <true if in pantry, else false>}\n'
		"    ]\n"
		"  }\n"
		"]"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	text = (response.text or "").strip()

	if text.startswith("```"):
		parts = text.split("```")
		text = parts[1] if len(parts) > 1 else ""
		if text.startswith("json"):
			text = text[4:]
	text = text.strip()

	try:
		raw: list[dict[str, Any]] = json.loads(text)
	except json.JSONDecodeError:
		return []

	results: list[dict[str, Any]] = []
	for entry in raw[:count]:
		if not isinstance(entry, dict):
			continue

		# Enrich each ingredient with expiry + image from the pantry
		enriched_ingredients: list[dict[str, Any]] = []
		for ing in entry.get("ingredients", []):
			if not isinstance(ing, dict):
				continue
			name = str(ing.get("name", "")).strip()
			pantry_item = inventory_map.get(name.lower())
			enriched_ingredients.append({
				"name": name,
				"in_inventory": bool(pantry_item),
				"expiry_date": (
					pantry_item["expiry_date"].isoformat()
					if pantry_item and isinstance(pantry_item.get("expiry_date"), datetime)
					else pantry_item.get("expiry_date") if pantry_item else None
				),
				"image_url": pantry_item.get("image_url") if pantry_item else None,
			})

		meal_name = entry.get("meal_type", "Meal Suggestion")
		youtube_search = entry.get("youtube_search", meal_name)

		# Fetch a real YouTube video so the embed iframe works
		youtube_url: str | None = None
		try:
			from web_scrape import get_youtube_cooking_video
			yt = get_youtube_cooking_video(youtube_search)
			if yt:
				youtube_url = yt["url"]
		except Exception:
			pass

		# Fetch a meal image via DuckDuckGo
		image_url: str | None = None
		try:
			from web_scrape import get_meal_image
			image_url = get_meal_image(meal_name)
		except Exception:
			pass

		results.append({
			"meal_type": meal_name,
			"description": entry.get("description", ""),
			"image_url": image_url,
			"youtube_url": youtube_url,
			"ingredients": enriched_ingredients,
		})

	return results


def analyze_health_impacts(items: list[dict[str, Any]], tier: str = "fast") -> dict[str, list[dict[str, str]]]:
	"""Analyze pantry items for potential negative mental/physical health impacts.

	Returns standardized JSON-friendly buckets:
	{
	  "mental": [{"item_id": "...", "name": "...", "reason": "..."}],
	  "physical": [{"item_id": "...", "name": "...", "reason": "..."}]
	}
	"""
	client = _get_client()

	payload = []
	for item in items:
		payload.append({
			"item_id": str(item.get("item_id", "")),
			"name": str(item.get("name", "")).strip(),
			"category": item.get("category"),
			"ingredients_text": item.get("ingredients_text"),
			"allergens": item.get("allergens"),
			"nutriscore_grade": item.get("nutriscore_grade"),
			"nova_processing_level": item.get("nova_processing_level"),
			"additives_count": item.get("additives_count"),
			"low_sugar_match": item.get("low_sugar_match"),
			"low_salt_match": item.get("low_salt_match"),
			"low_fat_match": item.get("low_fat_match"),
			"contains_meat": item.get("contains_meat"),
			"contains_dairy": item.get("contains_dairy"),
		})

	prompt = (
		"You are a nutrition and health risk triage assistant. "
		"Analyze each pantry item for possible *negative* impact risks. "
		"Focus strongly on ingredient quality, additives, processing level, sugar/salt/fat profile, allergens, and plausible dietary effects. "
		"For mental-health risk, look for plausible mood/cognition/sleep impact patterns from highly processed foods, high sugar swings, caffeine-like patterns, or additives when supported by ingredient clues. "
		"For physical-health risk, look for plausible cardiometabolic, inflammatory, GI, allergy, or long-term diet quality concerns. "
		"Only flag when there is a meaningful possibility; otherwise keep impact false. "
		"Reasons must be exactly one concise sentence and reference the likely ingredient/profile driver. "
		"Each reason MUST start with a short 1-3 word Driver label followed by a colon, then the sentence. "
		"Use one of these Driver labels whenever applicable: Empty Calories, High Sugar, High Sodium, Saturated Fat, Ultra-Processed, Additives, Caffeine, Allergen Risk, Sleep Impact, Mood Impact, Digestive Stress, Inflammation Risk. "
		"Example reason format: 'Empty Calories: Alcohol contributes calories with little nutritional value and can worsen metabolic strain over time.' "
		"Do not give medical diagnosis.\n\n"
		"Return ONLY valid JSON (no markdown):\n"
		"{\n"
		"  \"items\": [\n"
		"    {\n"
		"      \"item_id\": \"<item id from input>\",\n"
		"      \"name\": \"<item name>\",\n"
		"      \"mental\": {\"impact\": true|false, \"reason\": \"<single sentence reason or empty string>\"},\n"
		"      \"physical\": {\"impact\": true|false, \"reason\": \"<single sentence reason or empty string>\"}\n"
		"    }\n"
		"  ]\n"
		"}\n\n"
		f"Pantry batch JSON:\n{json.dumps(payload, ensure_ascii=False)}"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	raw = (response.text or "").strip()

	if raw.startswith("```"):
		parts = raw.split("```")
		raw = parts[1] if len(parts) > 1 else ""
		if raw.startswith("json"):
			raw = raw[4:]
	raw = raw.strip()

	try:
		parsed = json.loads(raw)
	except json.JSONDecodeError:
		return {"mental": [], "physical": []}

	mental: list[dict[str, str]] = []
	physical: list[dict[str, str]] = []
	seen_mental: set[str] = set()
	seen_physical: set[str] = set()

	for entry in parsed.get("items", []) if isinstance(parsed, dict) else []:
		if not isinstance(entry, dict):
			continue

		item_id = str(entry.get("item_id", "")).strip()
		name = str(entry.get("name", "")).strip()
		if not name:
			continue

		mental_obj = entry.get("mental")
		if isinstance(mental_obj, dict) and bool(mental_obj.get("impact")):
			reason = str(mental_obj.get("reason", "")).strip()
			key = item_id or name.lower()
			if reason and key not in seen_mental:
				seen_mental.add(key)
				mental.append({"item_id": item_id, "name": name, "reason": reason})

		physical_obj = entry.get("physical")
		if isinstance(physical_obj, dict) and bool(physical_obj.get("impact")):
			reason = str(physical_obj.get("reason", "")).strip()
			key = item_id or name.lower()
			if reason and key not in seen_physical:
				seen_physical.add(key)
				physical.append({"item_id": item_id, "name": name, "reason": reason})

	return {"mental": mental, "physical": physical}


def parse_receipt_items(lines: list[str], tier: str = "strong") -> list[str]:
	"""Decode OCR receipt lines into likely real food items.

	The model is asked to aggressively normalize noisy OCR tokens to canonical food names,
	while dropping entries that are non-food or too uncertain.
	"""
	client = _get_client()

	text = "\n".join(lines)
	prompt = (
		"You are an expert grocery receipt decoder. OCR text can be noisy, abbreviated, split, or misspelled. "
		"Try hard to infer the intended real food product from each candidate line by using common grocery patterns, "
		"typical SKU abbreviations, and obvious OCR corrections (e.g., M1LK->Milk, CHKN->Chicken, BRD->Bread). "
		"Return only items that are likely foods. "
		"If an entry is very likely NOT food (cleaning products, household goods, batteries, toiletries, pet supplies, etc.), drop it. "
		"If you cannot determine a real food with reasonable confidence, drop it. "
		"Keep produce/meat/dairy/frozen/pantry/beverages as food. "
		"Deduplicate near-duplicates and normalize names into clean shopper-friendly food names. "
		"Do not include quantities, prices, IDs, or store metadata.\n\n"
		"Return ONLY valid JSON (no markdown) in this shape:\n"
		"[\n"
		"  {\"raw\":\"<raw OCR line>\", \"food_name\":\"<normalized food name>\", \"is_food\":true|false, \"confidence\":0.0-1.0}\n"
		"]\n\n"
		"Only keep entries with is_food=true and confidence>=0.70 in your final mapping decisions.\n\n"
		f"OCR lines:\n{text}"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	raw = (response.text or "").strip()

	if raw.startswith("```"):
		parts = raw.split("```")
		raw = parts[1] if len(parts) > 1 else ""
		if raw.startswith("json"):
			raw = raw[4:]
	raw = raw.strip()

	try:
		parsed = json.loads(raw)
	except json.JSONDecodeError:
		return []

	results: list[str] = []
	seen: set[str] = set()

	if isinstance(parsed, list):
		for entry in parsed:
			if isinstance(entry, str):
				name = entry.strip()
				key = name.lower()
				if name and key not in seen:
					seen.add(key)
					results.append(name)
				continue

			if not isinstance(entry, dict):
				continue

			is_food = bool(entry.get("is_food", False))
			confidence_raw = entry.get("confidence", 0)
			try:
				confidence = float(confidence_raw)
			except (TypeError, ValueError):
				confidence = 0.0

			if not is_food or confidence < 0.70:
				continue

			name = str(entry.get("food_name", "")).strip()
			if not name:
				continue

			key = name.lower()
			if key in seen:
				continue
			seen.add(key)
			results.append(name)

	return results


def _sort_by_expiry(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
	"""Sort pantry items soonest-expiring first; items without an expiry date go last."""
	def _expiry_key(item: dict[str, Any]):
		expiry = item.get("expiry_date")
		if isinstance(expiry, datetime):
			return expiry.replace(tzinfo=timezone.utc) if expiry.tzinfo is None else expiry
		return datetime.max.replace(tzinfo=timezone.utc)
	return sorted(items, key=_expiry_key)


def generate_expiry_recipe(items: list[dict[str, Any]], tier: str = "strong") -> dict[str, Any]:
	"""Generate a single recipe that prioritises the soonest-expiring pantry items.

	Returns a dict with:
		response       - friendly text explanation of the recipe
		meal           - name of the dish
		youtube-search - suggested YouTube video title for this dish
		ingredients    - list of {"name": str, "inInventory": bool}
	"""
	client = _get_client()

	sorted_items = _sort_by_expiry(items)
	inventory_names = {str(i.get("name", "")).strip().lower() for i in sorted_items if i.get("name")}
	formatted = _format_pantry_items(sorted_items, max_items=80)

	prompt = (
		"You are a food waste reduction assistant. "
		"Given the pantry below (listed soonest-expiring first), suggest ONE practical recipe "
		"that uses as many of the listed items as possible, prioritising those expiring soonest. "
		"You may add a small number of common staple ingredients not in the pantry if necessary.\n\n"
		"Pantry items:\n"
		f"{formatted}\n\n"
		"Return ONLY a valid JSON object (no markdown, no explanation) with exactly these fields:\n"
		"{\n"
		'  "response": "<friendly paragraph describing the recipe and why it reduces waste>",\n'
		'  "meal": "<name of the dish>",\n'
		'  "youtube-search": "<title of a YouTube video someone might search to cook this dish>",\n'
		'  "ingredients": [\n'
		'    {"name": "<ingredient name>", "inInventory": <true if this ingredient is in the pantry list, else false>}\n'
		"  ]\n"
		"}"
	)

	response = client.models.generate_content(model=_select_model(tier), contents=prompt)
	text = (response.text or "").strip()

	# Strip markdown code fences if present
	if text.startswith("```"):
		parts = text.split("```")
		text = parts[1] if len(parts) > 1 else ""
		if text.startswith("json"):
			text = text[4:]
	text = text.strip()

	try:
		data: dict[str, Any] = json.loads(text)
	except json.JSONDecodeError:
		data = {"response": text, "meal": "Unknown", "youtube-search": "", "ingredients": []}

	# Ensure inInventory is always a bool and cross-check against our actual inventory
	for ingredient in data.get("ingredients", []):
		if isinstance(ingredient, dict):
			ingredient["inInventory"] = ingredient.get("name", "").strip().lower() in inventory_names

	return data
