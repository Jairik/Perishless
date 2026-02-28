# Main entry point for the FastAPI backend, where all API endpoints are defined and implemented
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .docstore import create_user, add_food_item, get_food_items
from .oof import get_product_info, find_products_by_name
from .lm import generate_recipe_recommendation, gemini_chat_response

app = FastAPI(title="Perishless API")

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
    pass


# Get all information regarding a specific food item from the DB, given its id
@app.get("/api/items/{uuid}/{item_id}")
async def get_item(uuid: str, item_id: int):
    pass


# Add a new food item to the database given the barcode, scoped to the user uuid
@app.post("/api/items/{uuid}/barcode/{barcode}")
async def add_item_by_barcode(uuid: str, barcode: str):
    pass


# Add a custom food item to the database given its name, category, and expiry date, scoped to the user uuid
# NOTE: MUST SEND ALL THIS INFO IN THE POST REQUEST BODY
@app.post("/api/items/{uuid}")
async def add_item_by_name(uuid: str):
    pass


# Delete a food item from the database given its id, scoped to the user uuid
@app.delete("/api/items/{uuid}/{item_id}")
async def delete_item(uuid: str, item_id: int):
    # Remove from the "items" collection
    # Add to a "history" collection if the user consumed it
    pass


# Barcode lookup using an item's name (not user-specific)
@app.get("/api/searchItem/{name}")
async def lookup_item(name: str):
    pass


# Generate a recipe recommendation based on items expiring within the next week, scoped to user uuid
@app.get("/api/recipe-recommendation/{uuid}")
async def recipe_recommendation(uuid: str):
    pass


# Scan a receipt and add all items in it to the database, scoped to the user uuid
@app.post("/api/scanReceipt/{uuid}")
async def scan_receipt(uuid: str):
    pass


# Gemini chat request (user-specific for personalized reccomendations based on pantry)
@app.post("/api/llm/{uuid}/{message}")
async def gemini_chat(message: str):
    pass

# Make a new user in the database given a uuid
@app.post("/api/createUser/{uuid}")
async def create_user(uuid: str):
    

# Entry point
if __name__ == "__main__":
    import uvicorn
    init_db()
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
