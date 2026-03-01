# Relational DB layer — MySQL (Google Cloud SQL) via Cloud SQL Python Connector
# Uses google.cloud.sql.connector so no external proxy process is required.

from __future__ import annotations

import atexit
import os
from contextlib import contextmanager
from typing import Any, Generator

from dotenv import load_dotenv
from google.cloud.sql.connector import Connector, IPTypes
from sqlalchemy import create_engine, Connection, text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import QueuePool

load_dotenv()

# ---------------------------------------------------------------------------
# Connection-string env vars  (handle the typo in the original .env key too)
# ---------------------------------------------------------------------------
_INSTANCE = (
    os.getenv("GOOGLE_CLOUD_CONNECTION_STRING")
    or os.getenv("GOOGLE_CLOUD_CONNECTION_STIRNG")
    or ""
)
_DB_USER  = os.getenv("GOOGLE_CLOUD_USERNAME") or os.getenv("DB_USER", "root")
_DB_PASS  = os.getenv("GOOGLE_CLOUD_PASSWORD") or os.getenv("DB_PASSWORD", "")
_DB_NAME  = os.getenv("DB_NAME", "products")

# ---------------------------------------------------------------------------
# Singleton connector + engine
# ---------------------------------------------------------------------------
_connector: Connector | None = None
_engine:    Engine    | None = None


def _build_engine() -> Engine:
    """Create the SQLAlchemy engine backed by the Cloud SQL Python Connector."""
    global _connector

    _connector = Connector()

    def _creator():
        return _connector.connect(  # type: ignore[union-attr]
            instance_connection_string=_INSTANCE,
            driver="pymysql",
            user=_DB_USER,
            password=_DB_PASS,
            db=_DB_NAME,
            ip_type=IPTypes.PUBLIC,
            connect_timeout=10,
        )

    engine = create_engine(
        "mysql+pymysql://",
        creator=_creator,
        poolclass=QueuePool,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=1800,
    )

    atexit.register(lambda: _connector.close())  # type: ignore[union-attr]

    return engine


def get_engine() -> Engine:
    """Return the lazily-initialised, pooled SQLAlchemy engine (singleton)."""
    global _engine
    if _engine is None:
        _engine = _build_engine()
    return _engine


@contextmanager
def get_connection() -> Generator[Connection, None, None]:
    """Yield a SQLAlchemy connection from the pool."""
    with get_engine().connect() as conn:
        yield conn


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def ensure_autocomplete_table() -> None:
    """No-op — uses the existing products table, no setup required."""
    pass


def autocomplete_food_items(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Return up to *limit* product suggestions matching the partial input."""
    q = query.strip()
    if not q:
        return []

    limit = min(limit, 25)

    # Escape LIKE special chars so user input is always treated literally
    like_escaped   = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    prefix_pattern = like_escaped + "%"

    with get_connection() as conn:
        rows = conn.execute(
            text("""
                SELECT barcode, name, image
                FROM   products
                WHERE  name LIKE :pattern ESCAPE '\\\\'
                ORDER  BY name ASC
                LIMIT  :lim
            """),
            {"pattern": prefix_pattern, "lim": limit},
        ).fetchall()

    return [
        {
            "barcode": r.barcode,
            "name": r.name,
            "image_url": ("https://" + r.image[7:]) if r.image and r.image.startswith("http://") else (r.image or None),
        }
        for r in rows
    ]


def upsert_food_name(
    name: str | None,
    category: str | None,
    image_url: str | None,
) -> None:
    """No-op — products table is managed externally."""
    pass


def update_product_image(barcode: str, image_url: str) -> None:
    """Write the resolved image URL back to the products table so subsequent lookups are instant."""
    if not barcode or not image_url:
        return
    try:
        with get_connection() as conn:
            conn.execute(
                text("UPDATE products SET image = :img WHERE barcode = :bc AND (image IS NULL OR image = '')"),
                {"img": image_url, "bc": barcode},
            )
            conn.commit()
    except Exception:
        pass


def find_barcode_by_name(name: str) -> str | None:
    """Look up the best-matching barcode in the products table for a given item name.

    Tries exact match first, then case-insensitive prefix match.
    Returns the barcode string, or None if nothing found.
    """
    if not name or not name.strip():
        return None
    n = name.strip()
    try:
        with get_connection() as conn:
            # 1. Exact match (case-insensitive)
            row = conn.execute(
                text("SELECT barcode FROM products WHERE LOWER(name) = LOWER(:n) LIMIT 1"),
                {"n": n},
            ).fetchone()
            if row:
                return row.barcode

            # 2. Prefix match
            like_pat = n.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            row = conn.execute(
                text("SELECT barcode FROM products WHERE name LIKE :p ESCAPE '\\\\' LIMIT 1"),
                {"p": like_pat},
            ).fetchone()
            if row:
                return row.barcode
    except Exception:
        pass
    return None
