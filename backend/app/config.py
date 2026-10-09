import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def gemini_api_key() -> str:
    return os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()


def gemma_model() -> str:
    return os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it").strip()


def gemma_status() -> dict[str, str | bool]:
    key_configured = bool(gemini_api_key())
    model = gemma_model()
    return {
        "provider": "Google AI Studio",
        "key_configured": key_configured,
        "model": model,
        "model_configured": bool(model),
        "ready": key_configured and bool(model),
    }