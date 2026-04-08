"""Perception layer: screenshot capture + UIA tree extraction + downscaling."""

import base64
import io
import ctypes
import ctypes.wintypes
from dataclasses import dataclass

import re
import numpy as np
import mss
from PIL import Image

# Try pywinauto — may fail if no UIA-accessible app is in foreground
try:
    from pywinauto import Desktop
    HAS_PYWINAUTO = True
except ImportError:
    HAS_PYWINAUTO = False


TARGET_LONG_EDGE = 1280


@dataclass
class WindowInfo:
    title: str
    process_name: str
    rect: dict  # {x, y, w, h}
    hwnd: int


@dataclass
class UIANode:
    name: str
    control_type: str
    bbox: dict  # {x, y, w, h} in original screen pixels
    children: list


@dataclass
class CaptureResult:
    screenshot_b64: str
    screenshot_dimensions: dict  # {w, h} after downscale
    original_dimensions: dict    # {w, h} before downscale
    scale_factor: float
    monitor_offset: dict         # {x, y} top-left of captured monitor in virtual screen
    uia_tree: UIANode | None
    foreground_window: WindowInfo | None
    screenshot_img: Image.Image | None = None  # downscaled image for OCR


def get_foreground_window() -> WindowInfo | None:
    """Get info about the currently focused window."""
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None

    # Get window title
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value

    # Get process name
    pid = ctypes.wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    process_name = ""
    try:
        import ctypes.wintypes as wt
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if h:
            buf = ctypes.create_unicode_buffer(260)
            size = wt.DWORD(260)
            kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
            kernel32.CloseHandle(h)
            process_name = buf.value.rsplit("\\", 1)[-1] if buf.value else f"pid:{pid.value}"
        else:
            process_name = f"pid:{pid.value}"
    except Exception:
        process_name = f"pid:{pid.value}"

    # Get window rect
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                     ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))

    return WindowInfo(
        title=title,
        process_name=process_name,
        rect={"x": rect.left, "y": rect.top,
              "w": rect.right - rect.left, "h": rect.bottom - rect.top},
        hwnd=hwnd,
    )


def _get_process_path(pid: int) -> str | None:
    """Get the full executable path for a process ID."""
    try:
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        kernel32 = ctypes.windll.kernel32
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if h:
            buf = ctypes.create_unicode_buffer(260)
            size = ctypes.wintypes.DWORD(260)
            kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
            kernel32.CloseHandle(h)
            return buf.value if buf.value else None
    except Exception:
        pass
    return None


def _extract_icon_b64(process_path: str | None, hwnd: int) -> str | None:
    """Extract icon for a window/process as base64 PNG using DrawIconEx."""
    try:
        shell32 = ctypes.windll.shell32
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32

        hicon = None
        owns_icon = False  # track if we need to destroy the icon

        # Strategy 1: ExtractIconExW from exe path (most reliable)
        if process_path:
            large = (ctypes.c_void_p * 1)()
            small = (ctypes.c_void_p * 1)()
            count = shell32.ExtractIconExW(process_path, 0, large, small, 1)
            if count > 0:
                hicon = small[0] or large[0]
                owns_icon = True
                # Clean up the unused one
                other = large[0] if hicon == small[0] else small[0]
                if other:
                    user32.DestroyIcon(other)

        # Strategy 2: WM_GETICON
        if not hicon:
            hicon = user32.SendMessageW(hwnd, 0x007F, 0, 0)  # WM_GETICON, ICON_SMALL
            if not hicon:
                hicon = user32.SendMessageW(hwnd, 0x007F, 1, 0)  # ICON_BIG

        # Strategy 3: GetClassLongPtrW
        if not hicon:
            hicon = user32.GetClassLongPtrW(hwnd, -34)  # GCLP_HICONSM
            if not hicon:
                hicon = user32.GetClassLongPtrW(hwnd, -14)  # GCL_HICON

        if not hicon:
            return None

        # Render icon onto a 32x32 bitmap using DrawIconEx
        w, h = 32, 32

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", ctypes.wintypes.DWORD),
                ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", ctypes.c_ushort), ("biBitCount", ctypes.c_ushort),
                ("biCompression", ctypes.wintypes.DWORD),
                ("biSizeImage", ctypes.wintypes.DWORD),
                ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", ctypes.wintypes.DWORD), ("biClrImportant", ctypes.wintypes.DWORD),
            ]

        hdc_screen = user32.GetDC(0)
        hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
        hbm = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
        old_bm = gdi32.SelectObject(hdc_mem, hbm)

        # Draw icon
        DI_NORMAL = 0x0003
        user32.DrawIconEx(hdc_mem, 0, 0, hicon, w, h, 0, 0, DI_NORMAL)

        # Extract pixels
        bi = BITMAPINFOHEADER()
        bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.biWidth = w
        bi.biHeight = -h  # top-down
        bi.biPlanes = 1
        bi.biBitCount = 32
        bi.biCompression = 0

        pixel_buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(hdc_mem, hbm, 0, h, pixel_buf, ctypes.byref(bi), 0)

        # Clean up GDI
        gdi32.SelectObject(hdc_mem, old_bm)
        gdi32.DeleteObject(hbm)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(0, hdc_screen)
        if owns_icon:
            user32.DestroyIcon(hicon)

        # Convert to PNG
        img = Image.frombuffer("RGBA", (w, h), pixel_buf.raw, "raw", "BGRA", 0, 1)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    except Exception:
        return None


# System window titles to skip when enumerating
_SKIP_TITLES = {
    "Program Manager", "MSCTFIME UI", "Default IME",
    "Windows Input Experience", "Microsoft Text Input Application",
    "Windows Shell Experience Host", "", "Search",
}


def enumerate_windows() -> list[dict]:
    """List all visible top-level windows with title, process name, and icon."""
    user32 = ctypes.windll.user32
    results = []

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                     ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True

        # Get title
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value

        if title in _SKIP_TITLES:
            return True

        # Skip tiny/hidden windows
        rect = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        if w < 50 or h < 50:
            return True

        # Get process info
        pid = ctypes.wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc_path = _get_process_path(pid.value)
        process_name = proc_path.rsplit("\\", 1)[-1] if proc_path else f"pid:{pid.value}"

        # Extract icon
        icon_b64 = _extract_icon_b64(proc_path, hwnd)

        results.append({
            "hwnd": hwnd,
            "title": title,
            "process_name": process_name,
            "icon_b64": icon_b64,
            "rect": {"x": rect.left, "y": rect.top, "w": w, "h": h},
        })
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(callback), 0)

    return results


def capture_window(hwnd: int) -> dict | None:
    """Capture a specific window by HWND, even if it's behind other windows.

    Uses PrintWindow with PW_RENDERFULLCONTENT for background capture.
    Returns dict with screenshot_b64, dimensions, scale_factor, or None on failure.
    """
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    if not user32.IsWindow(hwnd):
        return None

    # Check if minimized — can't capture minimized windows
    if user32.IsIconic(hwnd):
        return {"error": "window_minimized", "hwnd": hwnd}

    # Get window rect
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                     ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None

    # Get window title
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(length + 1, 1))
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value

    # Create compatible DC and bitmap
    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    old_bm = gdi32.SelectObject(hdc_mem, hbm)

    # PrintWindow with PW_RENDERFULLCONTENT
    PW_RENDERFULLCONTENT = 0x00000002
    success = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)

    if not success:
        # Fallback: try without PW_RENDERFULLCONTENT
        success = user32.PrintWindow(hwnd, hdc_mem, 0)

    if not success:
        gdi32.SelectObject(hdc_mem, old_bm)
        gdi32.DeleteObject(hbm)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(0, hdc_screen)
        return None

    # Extract bitmap bits
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", ctypes.wintypes.DWORD),
            ("biWidth", ctypes.c_long),
            ("biHeight", ctypes.c_long),
            ("biPlanes", ctypes.c_ushort),
            ("biBitCount", ctypes.c_ushort),
            ("biCompression", ctypes.wintypes.DWORD),
            ("biSizeImage", ctypes.wintypes.DWORD),
            ("biXPelsPerMeter", ctypes.c_long),
            ("biYPelsPerMeter", ctypes.c_long),
            ("biClrUsed", ctypes.wintypes.DWORD),
            ("biClrImportant", ctypes.wintypes.DWORD),
        ]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # top-down
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    buf_size = w * h * 4
    pixel_buf = ctypes.create_string_buffer(buf_size)
    gdi32.GetDIBits(hdc_mem, hbm, 0, h, pixel_buf, ctypes.byref(bi), 0)

    # Clean up GDI
    gdi32.SelectObject(hdc_mem, old_bm)
    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)

    # Convert to PIL Image (BGRA → RGB)
    img = Image.frombuffer("RGBA", (w, h), pixel_buf.raw, "raw", "BGRA", 0, 1)
    img = img.convert("RGB")

    original_dims = {"w": w, "h": h}
    resized, scale_factor = downscale(img)
    b64 = image_to_base64(resized)

    return {
        "screenshot_b64": b64,
        "screenshot_dimensions": {"w": resized.width, "h": resized.height},
        "original_dimensions": original_dims,
        "scale_factor": scale_factor,
        "hwnd": hwnd,
        "title": title,
    }


def find_monitor_for_window(window_rect: dict) -> dict | None:
    """Find which mss monitor contains the center of the given window."""
    cx = window_rect["x"] + window_rect["w"] // 2
    cy = window_rect["y"] + window_rect["h"] // 2
    with mss.mss() as sct:
        # monitors[0] is the virtual screen, [1+] are individual monitors
        for mon in sct.monitors[1:]:
            if (mon["left"] <= cx < mon["left"] + mon["width"] and
                    mon["top"] <= cy < mon["top"] + mon["height"]):
                return mon
    return None


def capture_screenshot(window_rect: dict | None = None) -> tuple[Image.Image, dict, dict]:
    """Capture the monitor containing the foreground window.

    Returns (PIL Image, {w, h}, monitor_offset {x, y}).
    monitor_offset is the top-left of the captured monitor in virtual screen space.
    """
    with mss.mss() as sct:
        monitor = None
        if window_rect:
            monitor = find_monitor_for_window(window_rect)
        if not monitor:
            monitor = sct.monitors[1]  # fallback to primary monitor

        raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    offset = {"x": monitor["left"], "y": monitor["top"]}
    return img, {"w": img.width, "h": img.height}, offset


def downscale(img: Image.Image, target_long_edge: int = TARGET_LONG_EDGE) -> tuple[Image.Image, float]:
    """Downscale image so the long edge is target_long_edge. Returns (image, scale_factor)."""
    w, h = img.size
    long_edge = max(w, h)
    if long_edge <= target_long_edge:
        return img, 1.0
    scale = target_long_edge / long_edge
    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    return resized, 1.0 / scale  # scale_factor: multiply downscaled coords to get original


def image_to_base64(img: Image.Image) -> str:
    """Encode PIL Image to base64 PNG string."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def extract_uia_tree(hwnd: int, max_depth: int = 5) -> UIANode | None:
    """Extract the UI Automation tree for a window. Returns None if UIA is unavailable."""
    if not HAS_PYWINAUTO:
        return None

    try:
        desktop = Desktop(backend="uia")
        # Find the window by handle
        from pywinauto.controls.uiawrapper import UIAWrapper
        from pywinauto import findwindows
        element = UIAWrapper(findwindows.find_element(handle=hwnd, backend="uia"))
        return _walk_element(element, depth=0, max_depth=max_depth)
    except Exception:
        return None


def _walk_element(element, depth: int, max_depth: int) -> UIANode | None:
    """Recursively walk a UIA element tree."""
    if depth > max_depth:
        return None

    try:
        rect = element.rectangle()
        bbox = {
            "x": rect.left, "y": rect.top,
            "w": rect.width(), "h": rect.height(),
        }

        # Skip tiny elements
        if bbox["w"] < 10 or bbox["h"] < 10:
            return None

        name = element.element_info.name or ""
        control_type = element.element_info.control_type or ""

        children = []
        if depth < max_depth:
            try:
                for child in element.children():
                    node = _walk_element(child, depth + 1, max_depth)
                    if node is not None:
                        children.append(node)
            except Exception:
                pass

        # Skip nameless leaf nodes (structural/decorative)
        if not name and not children:
            return None

        return UIANode(
            name=name,
            control_type=control_type,
            bbox=bbox,
            children=children,
        )
    except Exception:
        return None


def find_uia_element(node: UIANode | None, target_name: str) -> UIANode | None:
    """Search the UIA tree for an element whose name fuzzy-matches the target.

    Returns the best matching node, or None if no match found.
    """
    if node is None or not target_name:
        return None

    target_lower = target_name.lower().strip()
    best_match = None
    best_score = 0

    def _search(n: UIANode):
        nonlocal best_match, best_score
        name_lower = n.name.lower().strip()
        if not name_lower:
            pass
        elif name_lower == target_lower:
            # Exact match — best possible
            best_match = n
            best_score = 100
            return  # can't do better
        elif target_lower in name_lower or name_lower in target_lower:
            # Substring match
            score = 80
            # Prefer shorter names (more specific elements)
            score -= abs(len(name_lower) - len(target_lower))
            if score > best_score:
                best_match = n
                best_score = score

        if best_score >= 100:
            return
        for child in n.children:
            _search(child)
            if best_score >= 100:
                return

    _search(node)
    return best_match


def ground_step_with_uia(
    element_name: str,
    description: str,
    uia_tree: UIANode | None,
    monitor_offset: dict,
    scale_factor: float,
) -> dict | None:
    """Try to find the target element in the UIA tree and return corrected coordinates.

    Returns dict with {x, y, bbox, confidence} in SCREENSHOT pixel space, or None if no match.
    The coordinates are in screenshot space so they match what the VLM returns.
    """
    if uia_tree is None:
        return None

    # Try matching by element_name first, then by keywords from description
    match = find_uia_element(uia_tree, element_name)

    if match is None and description:
        # Try key phrases from the description
        # e.g. "the 'API Keys' option" → try "API Keys"
        quoted = re.findall(r"['\"]([^'\"]+)['\"]", description)
        for phrase in quoted:
            match = find_uia_element(uia_tree, phrase)
            if match:
                break

    if match is None:
        return None

    # UIA bbox is in screen pixels. Convert to screenshot pixel space.
    # screen_px = screenshot_px * scale_factor + monitor_offset
    # → screenshot_px = (screen_px - monitor_offset) / scale_factor
    ox, oy = monitor_offset["x"], monitor_offset["y"]
    bbox_screenshot = {
        "x": (match.bbox["x"] - ox) / scale_factor,
        "y": (match.bbox["y"] - oy) / scale_factor,
        "w": match.bbox["w"] / scale_factor,
        "h": match.bbox["h"] / scale_factor,
    }
    center_x = bbox_screenshot["x"] + bbox_screenshot["w"] / 2
    center_y = bbox_screenshot["y"] + bbox_screenshot["h"] / 2

    return {
        "x": center_x,
        "y": center_y,
        "bbox": bbox_screenshot,
        "confidence": 0.95,
        "source": "uia",
        "matched_name": match.name,
    }


# ── OCR grounding fallback ───────────────────────────────────────────────────

# Lazy-load OCR engine (first call takes ~1s, subsequent calls are fast)
_ocr_engine = None

def _get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def run_ocr_on_image(img: Image.Image) -> list[dict]:
    """Run OCR on a PIL Image. Returns list of {text, bbox} in image pixel space."""
    ocr = _get_ocr()
    img_array = np.array(img)
    result, _ = ocr(img_array)
    if not result:
        return []

    detections = []
    for box, text, confidence in result:
        # box is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] — quadrilateral
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        detections.append({
            "text": text,
            "confidence": confidence,
            "bbox": {
                "x": min(xs),
                "y": min(ys),
                "w": max(xs) - min(xs),
                "h": max(ys) - min(ys),
            },
        })
    return detections


def ground_step_with_ocr(
    element_name: str,
    description: str,
    screenshot_img: Image.Image,
) -> dict | None:
    """Try to find the target text on screen via OCR. Returns coords in screenshot pixel space."""
    # Build search terms from element_name and quoted strings in description
    search_terms = []
    if element_name:
        search_terms.append(element_name.lower().strip())
    if description:
        quoted = re.findall(r"['\"]([^'\"]+)['\"]", description)
        search_terms.extend(q.lower().strip() for q in quoted)

    if not search_terms:
        return None

    detections = run_ocr_on_image(screenshot_img)
    if not detections:
        return None

    # Search for best match
    best = None
    best_score = 0

    for det in detections:
        det_text = det["text"].lower().strip()
        for term in search_terms:
            score = 0
            if det_text == term:
                score = 100  # exact match
            elif term in det_text:
                score = 80 - (len(det_text) - len(term))  # substring, prefer shorter
            elif det_text in term:
                score = 70
            if score > best_score:
                best_score = score
                best = det

    if best is None or best_score < 50:
        return None

    bbox = best["bbox"]
    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2

    return {
        "x": cx,
        "y": cy,
        "bbox": bbox,
        "confidence": 0.85,
        "source": "ocr",
        "matched_text": best["text"],
    }


# ── Set-of-Mark (SoM) grounding ─────────────────────────────────────────────

def detect_ui_regions(img: Image.Image) -> list[dict]:
    """Detect probable UI element regions on a screenshot using OCR + edge detection.

    Returns list of {id, bbox} where bbox is {x, y, w, h} in image pixel space.
    """
    import cv2

    # Get OCR detections as candidate regions
    ocr_regions = run_ocr_on_image(img)

    # Also detect rectangular regions via edge detection
    img_array = np.array(img)
    gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150)

    # Dilate to connect nearby edges into solid regions
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
    dilated = cv2.dilate(edges, kernel, iterations=2)

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    edge_regions = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        # Filter: reasonable UI element size
        if 20 < w < img.width * 0.8 and 12 < h < img.height * 0.5:
            # Skip very wide/short bars (likely separators)
            aspect = w / max(h, 1)
            if aspect < 20:
                edge_regions.append({"x": float(x), "y": float(y), "w": float(w), "h": float(h)})

    # Merge OCR regions + edge regions, deduplicating overlaps
    all_regions = []
    for det in ocr_regions:
        all_regions.append(det["bbox"])
    for bbox in edge_regions:
        # Check if this overlaps significantly with an existing region
        overlaps = False
        for existing in all_regions:
            if _iou(bbox, existing) > 0.3:
                overlaps = True
                break
        if not overlaps:
            all_regions.append(bbox)

    # Sort top-to-bottom, left-to-right for consistent numbering
    all_regions.sort(key=lambda b: (b["y"] // 30, b["x"]))

    # Assign IDs (1-indexed)
    return [{"id": i + 1, "bbox": r} for i, r in enumerate(all_regions)]


def _iou(a: dict, b: dict) -> float:
    """Intersection over union of two bboxes."""
    x1 = max(a["x"], b["x"])
    y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["w"], b["x"] + b["w"])
    y2 = min(a["y"] + a["h"], b["y"] + b["h"])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = a["w"] * a["h"]
    area_b = b["w"] * b["h"]
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0


def create_som_image(img: Image.Image, regions: list[dict]) -> Image.Image:
    """Draw numbered boxes on a copy of the screenshot for SoM prompting."""
    from PIL import ImageDraw, ImageFont

    annotated = img.copy()
    draw = ImageDraw.Draw(annotated)

    # Try to get a readable font
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()

    for region in regions:
        rid = region["id"]
        b = region["bbox"]
        x, y, w, h = b["x"], b["y"], b["w"], b["h"]

        # Draw red outline
        draw.rectangle([x, y, x + w, y + h], outline="#FF3333", width=2)

        # Draw number label with background
        label = str(rid)
        label_bbox = font.getbbox(label)
        lw = label_bbox[2] - label_bbox[0] + 6
        lh = label_bbox[3] - label_bbox[1] + 4

        # Position label at top-left corner of the bbox
        lx, ly = x, y - lh - 2
        if ly < 0:
            ly = y + 2  # put inside if at top edge

        draw.rectangle([lx, ly, lx + lw, ly + lh], fill="#FF3333")
        draw.text((lx + 3, ly + 1), label, fill="white", font=font)

    return annotated


def uia_to_dict(node: UIANode | None) -> dict | None:
    """Convert UIANode tree to a JSON-serializable dict."""
    if node is None:
        return None
    return {
        "name": node.name,
        "control_type": node.control_type,
        "bbox": node.bbox,
        "children": [uia_to_dict(c) for c in node.children],
    }


def capture_context() -> CaptureResult:
    """Full perception pipeline: screenshot + UIA tree + downscale."""
    # Get foreground window info
    fg = get_foreground_window()

    # Capture the monitor containing the foreground window
    img, original_dims, monitor_offset = capture_screenshot(fg.rect if fg else None)

    # Extract UIA tree (if possible)
    uia_tree = None
    if fg and fg.hwnd:
        uia_tree = extract_uia_tree(fg.hwnd)

    # Downscale
    resized, scale_factor = downscale(img)
    b64 = image_to_base64(resized)

    return CaptureResult(
        screenshot_b64=b64,
        screenshot_dimensions={"w": resized.width, "h": resized.height},
        original_dimensions=original_dims,
        scale_factor=scale_factor,
        monitor_offset=monitor_offset,
        uia_tree=uia_tree,
        foreground_window=fg,
        screenshot_img=resized,
    )
