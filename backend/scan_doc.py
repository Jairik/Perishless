import cv2
import numpy as np
import pytesseract
from pyzbar.pyzbar import decode


# Detect the first barcode found in the image. Returns the decoded string or None
def detect_barcode(image_bytes: bytes) -> str | None:
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        return None

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Ordered preprocessing variants — cheapest/most-likely first
    def get_variants(g: np.ndarray) -> list[np.ndarray]:
        variants = [g]

        # Otsu threshold (handles clean, evenly-lit barcodes well)
        _, otsu = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(otsu)

        # Adaptive threshold (uneven lighting)
        adaptive = cv2.adaptiveThreshold(
            g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 31, 2
        )
        variants.append(adaptive)

        # Morphological close (fills small gaps in bars)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        morph = cv2.morphologyEx(g, cv2.MORPH_CLOSE, kernel)
        variants.append(morph)

        return variants

    def first_barcode(variants: list[np.ndarray]) -> str | None:
        for v in variants:
            barcodes = decode(v)
            if barcodes:
                return barcodes[0].data.decode("utf-8")
        return None

    # Try upright first — most common case
    result = first_barcode(get_variants(gray))
    if result:
        return result

    # Fall back to 90° rotations only if upright failed
    for k in (1, 3, 2):  # 90°, 270°, 180°
        rotated_gray = np.rot90(gray, k)
        result = first_barcode(get_variants(rotated_gray))
        if result:
            return result

    return None


def _upscale(image: np.ndarray, min_height: int = 1500) -> np.ndarray:
    """Upscale image so OCR has enough resolution; receipts shot on phone are often low-res."""
    h, w = image.shape[:2]
    if h < min_height:
        scale = min_height / h
        image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
    return image


def _correct_perspective(image: np.ndarray) -> np.ndarray:
    """Detect the largest quadrilateral (receipt outline) and warp it to a top-down view."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(blurred, 30, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edged = cv2.dilate(edged, kernel, iterations=2)

    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return image

    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    receipt_cnt = None
    for cnt in contours[:5]:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) == 4:
            receipt_cnt = approx
            break

    if receipt_cnt is None:
        return image

    pts = receipt_cnt.reshape(4, 2).astype(np.float32)
    # Order: top-left, top-right, bottom-right, bottom-left
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1)
    ordered = np.array([
        pts[np.argmin(s)],
        pts[np.argmin(d)],
        pts[np.argmax(s)],
        pts[np.argmax(d)],
    ], dtype=np.float32)

    (tl, tr, br, bl) = ordered
    w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if w < 50 or h < 50:
        return image

    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(ordered, dst)
    return cv2.warpPerspective(image, M, (w, h), flags=cv2.INTER_CUBIC)


def _deskew(gray: np.ndarray) -> np.ndarray:
    """Correct slight rotational skew using Hough line detection."""
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100,
                             minLineLength=gray.shape[1] // 4, maxLineGap=20)
    if lines is None:
        return gray

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        if x2 != x1:
            angles.append(np.degrees(np.arctan2(y2 - y1, x2 - x1)))

    if not angles:
        return gray

    # Filter to near-horizontal lines only (within ±30°)
    angles = [a for a in angles if abs(a) < 30]
    if not angles:
        return gray

    median_angle = np.median(angles)
    if abs(median_angle) < 0.3:  # Skip correction for negligible skew
        return gray

    (h, w) = gray.shape
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, median_angle, 1.0)
    rotated = cv2.warpAffine(gray, M, (w, h),
                              flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REPLICATE)
    return rotated


def _remove_shadow(gray: np.ndarray) -> np.ndarray:
    """Subtract illumination gradient to even out shadows across the receipt."""
    # Estimate background with a very large blur (background model)
    bg = cv2.medianBlur(gray, 21)
    bg = cv2.GaussianBlur(bg, (0, 0), sigmaX=51, sigmaY=51)
    # Divide to remove gradient; scale back to 0-255
    no_shadow = cv2.divide(gray.astype(np.float32), bg.astype(np.float32), scale=255.0)
    return np.clip(no_shadow, 0, 255).astype(np.uint8)


def _clahe(gray: np.ndarray) -> np.ndarray:
    """Contrast-Limited Adaptive Histogram Equalization — better than plain normalize."""
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def _sharpen(gray: np.ndarray) -> np.ndarray:
    """Unsharp mask to enhance fine character strokes."""
    blurred = cv2.GaussianBlur(gray, (0, 0), sigmaX=2)
    return cv2.addWeighted(gray, 1.8, blurred, -0.8, 0)


def _gamma(gray: np.ndarray, gamma: float = 1.5) -> np.ndarray:
    """Gamma correction — brightens dark receipt photos."""
    inv_gamma = 1.0 / gamma
    table = np.array([(i / 255.0) ** inv_gamma * 255 for i in range(256)], dtype=np.uint8)
    return cv2.LUT(gray, table)


def _binarize_variants(gray: np.ndarray) -> list[np.ndarray]:
    """Return multiple binarized versions to maximise OCR coverage."""
    variants = []

    # 1. Otsu on raw gray
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(otsu)

    # 2. Adaptive mean (best for uneven lighting)
    adaptive_mean = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 21, 10
    )
    variants.append(adaptive_mean)

    # 3. Adaptive Gaussian (smooth transitions)
    adaptive_gauss = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 8
    )
    variants.append(adaptive_gauss)

    # 4. Otsu on bilaterally-filtered image (preserves edges, removes grain)
    bilateral = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)
    _, otsu_bi = cv2.threshold(bilateral, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants.append(otsu_bi)

    # 5. Adaptive on CLAHE-equalised gray (helps faded thermal receipts)
    clahe_gray = _clahe(gray)
    adaptive_clahe = cv2.adaptiveThreshold(
        clahe_gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 31, 12
    )
    variants.append(adaptive_clahe)

    return variants


def _morphological_cleanup(binary: np.ndarray) -> np.ndarray:
    """Light morphological pass to close gaps in thin characters without merging them."""
    k_close = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 1))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, k_close)
    k_open = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 1))
    opened = cv2.morphologyEx(closed, cv2.MORPH_OPEN, k_open)
    return opened


def preprocess_receipt(image: np.ndarray) -> list[np.ndarray]:
    """
    Return a ranked list of preprocessed images for OCR.
    Each variant targets a different real-world receipt condition:
    crumpled, poorly lit, rotated, faded, or photographed at an angle.
    """
    # ── Stage 1: spatial corrections ────────────────────────────────────────
    image = _upscale(image)
    image = _correct_perspective(image)

    # ── Stage 2: grayscale base ──────────────────────────────────────────────
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()
    gray = _deskew(gray)

    # ── Stage 3: produce enhancement pipelines ───────────────────────────────
    pipelines: list[np.ndarray] = []

    # Pipeline A: shadow removal → CLAHE → sharpen  (most capable, run first)
    a = _sharpen(_clahe(_remove_shadow(gray)))
    pipelines.extend([_morphological_cleanup(v) for v in _binarize_variants(a)])

    # Pipeline B: bilat filter → CLAHE (less aggressive — good for clean receipts)
    b = _clahe(cv2.bilateralFilter(gray, d=11, sigmaColor=85, sigmaSpace=85))
    pipelines.extend([_morphological_cleanup(v) for v in _binarize_variants(b)])

    # Pipeline C: gamma-corrected (rescues very dark photos)
    c = _sharpen(_clahe(_gamma(gray, gamma=1.8)))
    pipelines.extend([_morphological_cleanup(v) for v in _binarize_variants(c)])

    # Pipeline D: plain denoised (last resort for already-clean scans)
    d = cv2.fastNlMeansDenoising(gray, h=10, templateWindowSize=7, searchWindowSize=21)
    _, otsu_d = cv2.threshold(d, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    pipelines.append(otsu_d)

    return pipelines


# Extract clean text lines from a receipt image.
def ocr_receipt(image_bytes: bytes) -> list[str]:
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        return []

    variants = preprocess_receipt(image)

    # Tesseract config: LSTM engine, single-column page layout (ideal for receipts)
    config = (
        "--oem 3 --psm 4 "
        "-c tessedit_char_whitelist="
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.$%:/-() "
        "-c preserve_interword_spaces=1"
    )

    best_lines: list[str] = []

    for variant in variants:
        text = pytesseract.image_to_string(variant, config=config)
        lines = [
            line.strip()
            for line in text.split("\n")
            if len(line.strip()) > 2
        ]
        # Keep the result with the most usable lines
        if len(lines) > len(best_lines):
            best_lines = lines

    return best_lines

    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        return None

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Ordered preprocessing variants — cheapest/most-likely first
    def get_variants(g: np.ndarray) -> list[np.ndarray]:
        variants = [g]

        # Otsu threshold (handles clean, evenly-lit barcodes well)
        _, otsu = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(otsu)

        # Adaptive threshold (uneven lighting)
        adaptive = cv2.adaptiveThreshold(
            g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 31, 2
        )
        variants.append(adaptive)

        # Morphological close (fills small gaps in bars)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        morph = cv2.morphologyEx(g, cv2.MORPH_CLOSE, kernel)
        variants.append(morph)

        return variants

    def first_barcode(variants: list[np.ndarray]) -> str | None:
        for v in variants:
            barcodes = decode(v)
            if barcodes:
                return barcodes[0].data.decode("utf-8")
        return None

    # Try upright first — most common case
    result = first_barcode(get_variants(gray))
    if result:
        return result

    # Fall back to 90° rotations only if upright failed
    for k in (1, 3, 2):  # 90°, 270°, 180°
        rotated_gray = np.rot90(gray, k)
        result = first_barcode(get_variants(rotated_gray))
        if result:
            return result

    return None


# Apply preprocessing steps optimized for receipt OCR.
def preprocess_receipt(image):
    # Convert to grayscale
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Increase contrast
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)

    # Remove noise
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    # Adaptive thresholding works best for receipts
    thresh = cv2.adaptiveThreshold(
        blur,
        255,
        cv2.ADAPTIVE_THRESH_MEAN_C,
        cv2.THRESH_BINARY,
        31,
        10
    )

    # Morphological cleanup
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    cleaned = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    return cleaned


# Extract clean text lines from a receipt image.
def ocr_receipt(image_bytes: bytes) -> list[str]:
    # Decode image
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        return []

    processed = preprocess_receipt(image)

    # Tesseract configuration optimized for receipts
    config = r"""
        --oem 3
        --psm 6
        -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.$%:/-
    """

    text = pytesseract.image_to_string(processed, config=config)

    # Clean and split lines
    lines = [
        line.strip()
        for line in text.split("\n")
        if len(line.strip()) > 2
    ]

    return lines