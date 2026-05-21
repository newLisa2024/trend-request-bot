import httpx
from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def search_residents(query: str) -> list[dict]:
    """Ищет резидентов по ФИО. Сначала точное вхождение, потом по первому слову."""
    result = supabase.from_("residents") \
        .select("id, full_name, status") \
        .ilike("full_name", f"%{query}%") \
        .limit(7).execute()

    if result.data:
        return result.data

    # Пробуем по первому слову (фамилия)
    first_word = query.strip().split()[0]
    if len(first_word) > 2:
        result = supabase.from_("residents") \
            .select("id, full_name, status") \
            .ilike("full_name", f"%{first_word}%") \
            .limit(7).execute()
        return result.data or []

    return []


def insert_request(data: dict) -> dict | None:
    """Вставляет запрос в таблицу requests."""
    result = supabase.from_("requests").insert(data).execute()
    return result.data[0] if result.data else None


async def trigger_embedding(request_id: str):
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{SUPABASE_URL}/functions/v1/generate-embedding",
            json={"table": "requests", "id": request_id},
            headers={"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"},
        )
        return resp.json()
