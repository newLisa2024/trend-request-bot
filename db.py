import os
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
    from openai import AsyncOpenAI
    from config import SUPABASE_URL, SUPABASE_SERVICE_KEY
    import json

    openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    # Загружаем запрос из базы
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/requests",
            params={"select": "id,name,description,quote,req_group,req_area,req_niche", "id": f"eq.{request_id}"},
            headers={"apikey": SUPABASE_SERVICE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"}
        )
        rows = resp.json()

    if not rows:
        return

    r = rows[0]
    parts = []
    if r.get("name"): parts.append(f"Запрос: {r['name']}")
    if r.get("req_group"): parts.append(f"Группа: {r['req_group']}")
    if r.get("req_niche"): parts.append(f"Отрасль: {', '.join(r['req_niche'])}")
    if r.get("req_area"): parts.append(f"Область: {', '.join(r['req_area'])}")
    if r.get("description"): parts.append(f"Описание: {r['description'][:500]}")
    if r.get("quote"): parts.append(f"Прямая речь: \"{r['quote']}\"")
    text = "\n".join(parts)[:2000]

    # Генерируем эмбеддинг
    response = await openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=text
    )
    embedding = response.data[0].embedding

    # Сохраняем в базу
    async with httpx.AsyncClient() as client:
        await client.patch(
            f"{SUPABASE_URL}/rest/v1/requests",
            params={"id": f"eq.{request_id}"},
            headers={"apikey": SUPABASE_SERVICE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}", "Content-Type": "application/json"},
            content=json.dumps({"embedding": f"[{','.join(map(str, embedding))}]"})
        )
