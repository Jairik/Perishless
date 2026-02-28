# All functions and configurations regarding the Firestore Database document store
from firebase_admin import credentials, firestore

# Authenticate with Firebase using the service account key JSON file
cred = credentials.Certificate("perishless-3c73c-firebase-adminsdk-49l7n-8c9b1e5a0c.json")
firebase_admin.initialize_app(cred)

# Get a global reference to the Firestore client
db = firestore.client()

# Create a new user collection
def create_user(uuid: str):
    user_ref = db.collection("users").document(uuid)
    user_ref.set({"created_at": firestore.SERVER_TIMESTAMP})
    
# Add a new food item to the user's collection
def add_food_item(uuid: str, item_data: dict):
    items_ref = db.collection("users").document(uuid).collection("items")
    items_ref.add(item_data)
    
# Get all food items for a user, optionally filtered by category or days until expiry
def get_food_items(uuid: str, category: str | None = None, days_until_expiry: int | None = None):
    items_ref = db.collection("users").document(uuid).collection("items")
    query = items_ref
    if category:
        query = query.where("category", "==", category)
    if days_until_expiry is not None:
        query = query.where("expiry_date", "<=", firestore.SERVER_TIMESTAMP + timedelta(days=days_until_expiry))
    return [doc.to_dict() for doc in query.stream()]