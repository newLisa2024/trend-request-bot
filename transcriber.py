import httpx
from config import GROQ_API_KEY


async def transcribe_voice(ogg_bytes: bytes) -> str:
    """
    Транскрибирует голосовое сообщение через Groq Whisper.
    Принимает байты OGG-файла, возвращает текст.
    """
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": ("voice.ogg", ogg_bytes, "audio/ogg")},
            data={
                "model": "whisper-large-v3",
                "language": "ru",
                "response_format": "text",
            },
        )
        resp.raise_for_status()
        return resp.text.strip()
