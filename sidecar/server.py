"""Nudge Python sidecar — stdin/stdout JSON-RPC server.

Handles screen capture and UI grounding. AI inference is handled
by the backend (NudgePlatform). Communicates with the Tauri shell
via line-delimited JSON over stdin/stdout.
"""

import json
import re
import sys
import os
import time
import traceback

# Add parent dir so we can import capture/brain
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from capture import (
    capture_context, uia_to_dict, ground_step_with_uia,
)
from brain import StepPlan, Step, Target


# Grounding settings (togglable from settings UI)
grounding_settings = {
    "uia": True,
    "ocr": True,
}


def handle_set_grounding(params: dict) -> dict:
    """Update grounding toggles."""
    for key in ("uia", "ocr"):
        if key in params:
            grounding_settings[key] = bool(params[key])
    return {"result": grounding_settings}


def handle_get_settings(params: dict) -> dict:
    """Return current settings."""
    return {"result": {
        "grounding": grounding_settings,
    }}


def handle_capture_only(params: dict) -> dict:
    """Capture screen and return raw data (no AI call)."""
    context = capture_context()
    uia_dict = uia_to_dict(context.uia_tree)

    return {"result": {
        "screenshot_b64": context.screenshot_b64,
        "screenshot_dimensions": context.screenshot_dimensions,
        "original_dimensions": context.original_dimensions,
        "scale_factor": context.scale_factor,
        "monitor_offset": context.monitor_offset,
        "uia_tree": uia_dict,
        "foreground_window": {
            "title": context.foreground_window.title,
            "process_name": context.foreground_window.process_name,
        } if context.foreground_window else None,
    }}


def handle_ground_plan(params: dict) -> dict:
    """Ground a plan returned by the backend using local UIA/OCR.

    Takes a raw plan dict from the backend and applies local grounding
    to refine target coordinates using the current screen state.
    """
    plan_data = params["plan"]

    # Re-capture fresh context for grounding
    context = capture_context()

    # Convert backend response into StepPlan objects
    steps = []
    for s in plan_data.get("steps", []):
        t = s.get("target", {})
        target = Target(
            description=t.get("description", ""),
            element_name=t.get("element_name", ""),
            x=t.get("x", 0),
            y=t.get("y", 0),
            bbox=t.get("bbox"),
            confidence=t.get("confidence", 0.5),
        )
        steps.append(Step(
            step_number=s.get("step_number", 0),
            instruction=s.get("instruction", ""),
            target=target,
            action_type=s.get("action_type", "look_at"),
            action_detail=s.get("action_detail", ""),
        ))

    plan = StepPlan(
        app_context=plan_data.get("app_context", ""),
        steps=steps,
    )

    return {"result": _plan_to_dict(plan, context)}


def _plan_to_dict(plan, context) -> dict:
    """Convert a StepPlan to a serializable dict, with grounding.

    - UIA is fast (in-memory tree walk), always runs first if enabled
    - OCR runs ONCE per screenshot, results cached and reused for all steps
    """
    t0 = time.perf_counter()

    uia_on = grounding_settings["uia"]
    ocr_on = grounding_settings["ocr"]

    # Run OCR ONCE upfront, cache the detections
    ocr_detections = None
    if ocr_on and context.screenshot_img is not None:
        try:
            from capture import run_ocr_on_image
            ocr_detections = run_ocr_on_image(context.screenshot_img)
        except Exception:
            pass

    steps = []
    for step in plan.steps:
        target = _ground_single_step(step, context, uia_on, ocr_detections)
        steps.append({
            "step_number": step.step_number,
            "instruction": step.instruction,
            "target": target,
            "action_type": step.action_type,
            "action_detail": step.action_detail,
        })

    elapsed = time.perf_counter() - t0
    sys.stderr.write(f"[sidecar] grounding done in {elapsed:.2f}s\n")
    sys.stderr.flush()

    return {
        "app_context": plan.app_context,
        "steps": steps,
        "scale_factor": context.scale_factor,
        "monitor_offset_x": context.monitor_offset["x"],
        "monitor_offset_y": context.monitor_offset["y"],
    }


def _ground_single_step(step, context, uia_on, ocr_detections):
    """Ground a single step using the fallback chain. Returns a target dict."""
    name = step.target.element_name
    desc = step.target.description

    # 1. UIA (instant — in-memory tree walk)
    if uia_on and context.uia_tree:
        grounded = ground_step_with_uia(
            element_name=name, description=desc,
            uia_tree=context.uia_tree,
            monitor_offset=context.monitor_offset,
            scale_factor=context.scale_factor,
        )
        if grounded:
            return {
                "description": desc, "element_name": grounded["matched_name"],
                "x": grounded["x"], "y": grounded["y"],
                "bbox": grounded["bbox"], "confidence": grounded["confidence"],
                "grounding_source": "uia",
            }

    # 2. OCR (uses cached detections — no re-scan)
    if ocr_detections is not None:
        search_terms = []
        if name:
            search_terms.append(name.lower().strip())
        if desc:
            quoted = re.findall(r"['\"]([^'\"]+)['\"]", desc)
            search_terms.extend(q.lower().strip() for q in quoted)

        best = None
        best_score = 0
        for det in ocr_detections:
            det_text = det["text"].lower().strip()
            for term in search_terms:
                score = 0
                if det_text == term:
                    score = 100
                elif term in det_text:
                    score = 80 - (len(det_text) - len(term))
                elif det_text in term:
                    score = 70
                if score > best_score:
                    best_score = score
                    best = det

        if best and best_score >= 50:
            bbox = best["bbox"]
            return {
                "description": desc, "element_name": name,
                "x": bbox["x"] + bbox["w"] / 2, "y": bbox["y"] + bbox["h"] / 2,
                "bbox": bbox, "confidence": 0.85,
                "grounding_source": "ocr",
            }

    # 3. Fallback: raw VLM coordinates from backend
    return {
        "description": desc, "element_name": name,
        "x": step.target.x, "y": step.target.y,
        "bbox": step.target.bbox,
        "confidence": max(step.target.confidence * 0.5, 0.2),
        "grounding_source": "vlm_only",
    }


def handle_health_check(params: dict) -> dict:
    return {"result": "ok"}


HANDLERS = {
    "capture_only": handle_capture_only,
    "ground_plan": handle_ground_plan,
    "set_grounding": handle_set_grounding,
    "get_settings": handle_get_settings,
    "health_check": handle_health_check,
}


def main():
    """Read JSON-RPC requests from stdin, write responses to stdout."""
    sys.stderr.write("[sidecar] ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"error": f"invalid JSON: {e}"}
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        method = request.get("method", "")
        params = request.get("params", {})

        handler = HANDLERS.get(method)
        if not handler:
            response = {"error": f"unknown method: {method}"}
        else:
            try:
                response = handler(params)
            except Exception as e:
                sys.stderr.write(f"[sidecar] error in {method}: {traceback.format_exc()}\n")
                sys.stderr.flush()
                response = {"error": str(e)}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
