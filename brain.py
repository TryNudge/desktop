"""Brain layer: data types and response parsing for step plans."""

import json
from dataclasses import dataclass


@dataclass
class Target:
    description: str
    element_name: str
    x: float
    y: float
    bbox: dict | None
    confidence: float


@dataclass
class Step:
    step_number: int
    instruction: str
    target: Target
    action_type: str
    action_detail: str


@dataclass
class StepPlan:
    app_context: str
    steps: list[Step]


def parse_step_plan(raw: str) -> StepPlan:
    """Parse the model's JSON response into a StepPlan."""
    text = raw.strip()

    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
    if text.rstrip().endswith("```"):
        text = text.rstrip()
        text = text[: text.rfind("```")]
    text = text.strip()

    if not text.startswith("{"):
        start = text.find("{")
        if start != -1:
            text = text[start:]
    if not text.endswith("}"):
        end = text.rfind("}")
        if end != -1:
            text = text[: end + 1]

    data = json.loads(text)

    steps = []
    for s in data["steps"]:
        target_data = s["target"]
        coords = target_data.get("coordinates", {})
        bbox = target_data.get("bbox")

        target = Target(
            description=target_data.get("description", ""),
            element_name=target_data.get("element_name", ""),
            x=coords.get("x", 0),
            y=coords.get("y", 0),
            bbox=bbox,
            confidence=target_data.get("confidence", 0.5),
        )
        steps.append(Step(
            step_number=s["step_number"],
            instruction=s["instruction"],
            target=target,
            action_type=s.get("action_type", "look_at"),
            action_detail=s.get("action_detail", ""),
        ))

    return StepPlan(
        app_context=data.get("app_context", ""),
        steps=steps,
    )
