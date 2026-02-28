# Funny name, used to hold all information about Open Food Facts API interactions, and any related data processing
import openfoodfacts


# Initialize the Open Food Facts API client
oof_api = openfoodfacts.OpenFoodAPI(
    user_agent="Perishless/1.0,
    language="en",
    flavor="Flavor.off",
)

# Use the openfoodfacts library to get product information based on the barcode
def get_product_info(barcode: str):
    try:
        product = oof_api.get_product(barcode)
        if product.status == 1:
            data = product.product

        # Helper function to get the match value for a given attribute ID
        def get_attr_match(attr_id):
            for group in data.get("attribute_groups_en", []):
                for attr in group.get("attributes", []):
                    if attr.get("id") == attr_id:
                        return attr.get("match")
            return None

        # Get the category from the categories_tags field, which is a list of strings in the format "en:category-name"
        categories = data.get("categories_tags", [])

        return {
            # General product information
            "name": data.get("product_name", "Unknown"),
            "category": category = categories[0].split(":")[-1] if categories else "Unknown",
            "image_url": data.get("image_front_url") or data.get("image_url"),
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
        
        else:
            return None
    except Exception as e:
        print(f"Error fetching product info: {e}")
        return None


# Use the openfoodfacts library to search for products based on the name        
def find_products_by_name(name: str):
    try:
        results = oof_api.search(name, page_size=5)
        return [product.name for product in results.products]
    except Exception as e:
        print(f"Error searching for products: {e}")
        return []