from abc import ABC, abstractmethod
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.config import gemini_api_key, gemma_model


class ModelNotConfigured(Exception):
    pass


class ModelRequestFailed(Exception):
    pass


class ModelOutputInvalid(Exception):
    pass


class GemmaField(BaseModel):
    value: str = Field(max_length=1000)
    source_quote: str = Field(max_length=1000)
    uncertain: bool


class GemmaCapture(BaseModel):
    requested_action: GemmaField
    deadline: GemmaField
    required_items: list[GemmaField] = Field(max_length=10)
    owner: GemmaField


class LLMClient(ABC):
    @abstractmethod
    async def generate_capture(self, source: str) -> GemmaCapture:
        raise NotImplementedError

    @abstractmethod
    async def check(self) -> None:
        raise NotImplementedError


class GoogleGemmaClient(LLMClient):
    timeout_seconds = 35

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key if api_key is not None else gemini_api_key()
        self.model = model if model is not None else gemma_model()
        if not self.api_key:
            raise ModelNotConfigured("Add GEMINI_API_KEY to the backend environment.")
        if not self.model:
            raise ModelNotConfigured("Set GEMMA_MODEL to an available Gemma 4 model ID.")

    @property
    def endpoint(self) -> str:
        return f"https://generativelanguage.googleapis.com/v1beta/models/{quote(self.model, safe='-_.')}:generateContent"

    async def _generate(self, prompt: str, schema: dict) -> str:
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    self.endpoint,
                    headers={"x-goog-api-key": self.api_key},
                    json={
                        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "responseMimeType": "application/json",
                            "responseSchema": schema,
                            "temperature": 0.1,
                        },
                    },
                )
        except httpx.TimeoutException as error:
            raise ModelRequestFailed("Gemma did not respond before the request timed out.") from error
        except httpx.RequestError as error:
            raise ModelRequestFailed("Could not reach the Google Generative Language API.") from error

        if response.status_code in (401, 403):
            raise ModelRequestFailed("Google rejected the configured API key or its permissions.")
        if response.status_code == 404:
            raise ModelRequestFailed("Google could not find this Gemma model ID. Check GEMMA_MODEL.")
        if response.status_code == 429:
            raise ModelRequestFailed("The Google API quota or rate limit was reached.")
        if response.status_code >= 400:
            raise ModelRequestFailed(f"Google's model API returned HTTP {response.status_code}.")

        try:
            body = response.json()
            return body["candidates"][0]["content"]["parts"][0]["text"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ModelOutputInvalid("The model response did not contain structured text.") from error

    async def generate_capture(self, source: str) -> GemmaCapture:
        schema = {
            "type": "OBJECT",
            "properties": {
                "requested_action": self._field_schema(),
                "deadline": self._field_schema(),
                "required_items": {"type": "ARRAY", "items": self._field_schema()},
                "owner": self._field_schema(),
            },
            "required": ["requested_action", "deadline", "required_items", "owner"],
        }
        prompt = (
            "Extract a requested document-sending task from this source. Return only the requested JSON schema. "
            "Do not invent values. For every non-empty value, source_quote must be an exact substring copied from the source; "
            "if no exact supporting quote exists, return an empty value and empty quote and set uncertain=true. "
            "Mark relative deadlines such as Friday as uncertain because they lack a calendar date. "
            "List each requested attachment as a required_items entry. Never propose or execute a tool action.\n\n"
            f"SOURCE:\n{source}"
        )
        raw = await self._generate(prompt, schema)
        for attempt in range(2):
            try:
                return GemmaCapture.model_validate_json(raw)
            except ValidationError as error:
                if attempt:
                    raise ModelOutputInvalid("Gemma returned invalid structured data after one repair attempt.") from error
                raw = await self._generate(
                    "Repair the following response to match the required JSON schema exactly. Keep only values supported by the source. "
                    f"Validation error: {error.errors(include_input=False)}\nSOURCE:\n{source}\nRESPONSE:\n{raw}",
                    schema,
                )
        raise ModelOutputInvalid("Gemma returned invalid structured data.")

    async def check(self) -> None:
        await self._generate(
            'Return exactly this JSON object: {"ok": true}.',
            {"type": "OBJECT", "properties": {"ok": {"type": "BOOLEAN"}}, "required": ["ok"]},
        )

    @staticmethod
    def _field_schema() -> dict:
        return {
            "type": "OBJECT",
            "properties": {
                "value": {"type": "STRING"},
                "source_quote": {"type": "STRING"},
                "uncertain": {"type": "BOOLEAN"},
            },
            "required": ["value", "source_quote", "uncertain"],
        }