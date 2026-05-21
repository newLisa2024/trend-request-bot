import asyncio
import logging
from datetime import datetime, timezone

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
)

import httpx

from config import BOT_TOKEN, ALLOWED_USER_IDS
from db import search_residents, insert_request, trigger_embedding
from transcriber import transcribe_voice
from classifier import classify_request

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())


# ── FSM States ─────────────────────────────────────────────────────────────────

class RequestFlow(StatesGroup):
    waiting_resident   = State()  # ждём ФИО
    confirming_resident = State() # показываем варианты, ждём выбора
    waiting_request    = State()  # ждём текст/голос запроса
    showing_preview    = State()  # показываем превью, ждём да/нет


# ── Helpers ────────────────────────────────────────────────────────────────────

def make_resident_keyboard(residents: list[dict]) -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton(
            text=f"{r['full_name']}",
            callback_data=f"res:{r['id']}:{r['full_name'][:30]}"
        )]
        for r in residents
    ]
    buttons.append([InlineKeyboardButton(text="❌ Нет нужного — ввести заново", callback_data="res:none")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)


def make_confirm_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="✅ Сохранить", callback_data="confirm:yes"),
        InlineKeyboardButton(text="✏️ Переформулировать", callback_data="confirm:no"),
        InlineKeyboardButton(text="❌ Отменить", callback_data="confirm:cancel"),
    ]])


def format_preview(classified: dict, resident_name: str) -> str:
    modifiers = ", ".join(classified.get("active_modifiers") or []) or "—"
    areas = ", ".join(classified.get("req_area") or []) or "—"
    niches = ", ".join(classified.get("req_niche") or []) or "—"
    methods = ", ".join(classified.get("solution_method") or []) or "—"

    return (
        f"📋 <b>Превью запроса</b>\n\n"
        f"👤 <b>Резидент:</b> {resident_name}\n\n"
        f"📌 <b>Название:</b> {classified.get('name', '—')}\n\n"
        f"🏷 <b>Тип:</b> {classified.get('type_code')} — {classified.get('type_name', '—')}\n"
        f"🎯 <b>Цель:</b> {classified.get('req_goal', '—')}\n"
        f"⚡ <b>Приоритет:</b> {classified.get('priority', '—')}\n"
        f"🗂 <b>Область:</b> {areas}\n"
        f"🏭 <b>Ниша:</b> {niches}\n"
        f"🔧 <b>Метод:</b> {methods}\n"
        f"⚙️ <b>Модификаторы:</b> {modifiers}\n"
        f"👥 <b>Нужен:</b> {classified.get('required_role_b', '—')}\n"
        f"📊 <b>Группа весов:</b> {classified.get('req_group', '—')}\n"
        f"🤖 <b>Уверенность AI:</b> {classified.get('ai_confidence', '—')}%\n\n"
        f"📝 <b>Описание:</b>\n<code>{classified.get('description', '—')[:600]}</code>"
    )


# ── Handlers ───────────────────────────────────────────────────────────────────

@dp.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext):
    if message.from_user.id not in ALLOWED_USER_IDS:
        await message.answer("⛔ У тебя нет доступа к этому боту.")
        return
    await state.clear()
    await state.set_state(RequestFlow.waiting_resident)
    await message.answer(
        "👋 Привет! Отправь ФИО резидента — найду его в базе и добавим запрос."
    )


@dp.message(F.text == "/cancel")
async def cmd_cancel(message: Message, state: FSMContext):
    if message.from_user.id not in ALLOWED_USER_IDS:
        await message.answer("⛔ У тебя нет доступа к этому боту.")
        return
    await state.clear()
    await state.set_state(RequestFlow.waiting_resident)
    await message.answer("❌ Отменено. Отправь ФИО резидента чтобы начать заново.")


# ── Шаг 1: Ищем резидента ─────────────────────────────────────────────────────

@dp.message(RequestFlow.waiting_resident, F.text)
async def handle_resident_name(message: Message, state: FSMContext):
    if message.from_user.id not in ALLOWED_USER_IDS:
        await message.answer("⛔ У тебя нет доступа к этому боту.")
        return
    query = message.text.strip()
    if len(query) < 2:
        await message.answer("Введи хотя бы 2 символа для поиска.")
        return

    searching_msg = await message.answer("🔍 Ищу...")

    try:
        residents = search_residents(query)
    except Exception as e:
        await searching_msg.edit_text(f"⚠️ Ошибка поиска: {e}")
        return

    await searching_msg.delete()

    if not residents:
        await message.answer(
            f"🤷 Не нашёл резидента по запросу «{query}».\n"
            "Попробуй другую часть ФИО."
        )
        return

    if len(residents) == 1:
        r = residents[0]
        await state.update_data(resident_id=r["id"], resident_name=r["full_name"])
        await state.set_state(RequestFlow.waiting_request)
        await message.answer(
            f"✅ Резидент: <b>{r['full_name']}</b>\n\n"
            "Теперь отправь запрос — текстом или голосовым сообщением.\n"
            "/cancel — отменить",
            parse_mode="HTML"
        )
    else:
        await state.set_state(RequestFlow.confirming_resident)
        await message.answer(
            f"Нашёл несколько совпадений. Выбери нужного:",
            reply_markup=make_resident_keyboard(residents)
        )


# ── Шаг 1b: Выбор резидента из списка ─────────────────────────────────────────

@dp.callback_query(RequestFlow.confirming_resident, F.data.startswith("res:"))
async def handle_resident_choice(callback: CallbackQuery, state: FSMContext):
    if callback.from_user.id not in ALLOWED_USER_IDS:
        return
    parts = callback.data.split(":", 2)
    resident_id = parts[1]

    if resident_id == "none":
        await state.set_state(RequestFlow.waiting_resident)
        await callback.message.edit_text("Окей, введи другое ФИО:")
        return

    resident_name = parts[2] if len(parts) > 2 else "Резидент"
    await state.update_data(resident_id=resident_id, resident_name=resident_name)
    await state.set_state(RequestFlow.waiting_request)

    await callback.message.edit_text(
        f"✅ Резидент: <b>{resident_name}</b>\n\n"
        "Теперь отправь запрос — текстом или голосовым сообщением.\n"
        "/cancel — отменить",
        parse_mode="HTML"
    )


# ── Шаг 2: Принимаем запрос (текст или голос) ─────────────────────────────────

@dp.message(RequestFlow.waiting_request, F.text | F.voice)
async def handle_request_input(message: Message, state: FSMContext):
    if message.from_user.id not in ALLOWED_USER_IDS:
        await message.answer("⛔ У тебя нет доступа к этому боту.")
        return
    data = await state.get_data()
    resident_name = data.get("resident_name", "")

    processing_msg = await message.answer("⏳ Обрабатываю...")

    try:
        # Транскрибация голосового
        if message.voice:
            voice_file = await bot.get_file(message.voice.file_id)
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(
                    f"https://api.telegram.org/file/bot{BOT_TOKEN}/{voice_file.file_path}"
                )
            raw_text = await transcribe_voice(resp.content)
            await processing_msg.edit_text(
                f"🎙 Расшифровал голосовое:\n\n<i>{raw_text}</i>\n\n"
                "⏳ Классифицирую...",
                parse_mode="HTML"
            )
        else:
            raw_text = message.text.strip()
            await processing_msg.edit_text("⏳ Классифицирую...")

        # AI классификация
        classified = await classify_request(raw_text, resident_name)

        # Сохраняем в state
        await state.update_data(classified=classified, raw_text=raw_text)
        await state.set_state(RequestFlow.showing_preview)

        preview_text = format_preview(classified, resident_name)
        await processing_msg.edit_text(
            preview_text,
            parse_mode="HTML",
            reply_markup=make_confirm_keyboard()
        )

    except Exception as e:
        log.exception("Error during request processing")
        await processing_msg.edit_text(
            f"⚠️ Ошибка при обработке: {e}\n\nПопробуй ещё раз или /cancel"
        )


async def run_scoring(request_id: str):
    import asyncio
    proc = await asyncio.create_subprocess_exec(
        "node", "--env-file=.env", "score_new_request.js",
        env={**__import__("os").environ, "REQUEST_ID": request_id},
        cwd="/var/www/trend-request-bot"
    )
    await proc.wait()
    log.info(f"Scoring done for request {request_id}, exit code: {proc.returncode}")


# ── Шаг 3: Подтверждение и сохранение ─────────────────────────────────────────

@dp.callback_query(RequestFlow.showing_preview, F.data.startswith("confirm:"))
async def handle_confirm(callback: CallbackQuery, state: FSMContext):
    if callback.from_user.id not in ALLOWED_USER_IDS:
        return
    action = callback.data.split(":")[1]

    if action == "cancel":
        await state.clear()
        await state.set_state(RequestFlow.waiting_resident)
        await callback.message.edit_text("❌ Отменено. Введи ФИО резидента для нового запроса.")
        return

    if action == "no":
        await state.set_state(RequestFlow.waiting_request)
        await callback.message.edit_text(
            "✏️ Окей. Отправь запрос заново — переформулируй или дополни."
        )
        return

    # action == "yes" — сохраняем
    data = await state.get_data()
    classified = data["classified"]
    resident_id = data["resident_id"]
    resident_name = data["resident_name"]

    saving_msg = await callback.message.edit_text("💾 Сохраняю в базу...")

    try:
        now = datetime.now(timezone.utc).isoformat()

        row = {
            "resident_id": resident_id,
            "name": classified.get("name"),
            "description": classified.get("description"),
            "quote": classified.get("quote"),
            "type_code": classified.get("type_code"),
            "type_name": classified.get("type_name"),
            "req_group": classified.get("req_group"),
            "req_goal": classified.get("req_goal"),
            "req_area": classified.get("req_area"),
            "req_niche": classified.get("req_niche"),
            "active_modifiers": classified.get("active_modifiers"),
            "solution_method": classified.get("solution_method"),
            "required_role_b": classified.get("required_role_b"),
            "priority": classified.get("priority"),
            "ai_confidence": classified.get("ai_confidence"),
            "ai_reasoning": classified.get("ai_reasoning"),
            "req_reasoning": classified.get("ai_reasoning"),  # дублируем в req_reasoning
            "classified_by": "ai",
            "classified_at": now,
            "status": "Не верифицирован",
            "created_at": now,
        }

        inserted = insert_request(row)
        if not inserted:
            raise Exception("Supabase вернул пустой ответ")

        request_id = inserted["id"]
        try:
            await trigger_embedding(request_id)
            asyncio.create_task(run_scoring(request_id))
        except Exception as e:
            log.warning(f"Embedding error: {e}")

        await state.clear()
        await state.set_state(RequestFlow.waiting_resident)

        await saving_msg.edit_text(
            f"✅ <b>Запрос сохранён!</b>\n\n"
            f"👤 {resident_name}\n"
            f"📌 {classified.get('name')}\n"
            f"🏷 {classified.get('type_code')} · {classified.get('priority')}\n\n"
            f"Следующий резидент? Отправь ФИО.",
            parse_mode="HTML"
        )

    except Exception as e:
        log.exception("Error saving request")
        await saving_msg.edit_text(
            f"⚠️ Ошибка при сохранении: {e}\n\n"
            "Попробуй ещё раз или /cancel"
        )


# ── Fallback ───────────────────────────────────────────────────────────────────

@dp.message()
async def fallback(message: Message, state: FSMContext):
    if message.from_user.id not in ALLOWED_USER_IDS:
        await message.answer("⛔ У тебя нет доступа к этому боту.")
        return
    current_state = await state.get_state()
    if current_state is None:
        await state.set_state(RequestFlow.waiting_resident)
        await message.answer("Отправь ФИО резидента чтобы начать. /cancel — сброс.")
    elif current_state == RequestFlow.waiting_resident.state:
        await message.answer("Введи ФИО резидента текстом.")
    elif current_state == RequestFlow.waiting_request.state:
        await message.answer("Отправь запрос текстом или голосовым сообщением.")


# ── Entry point ────────────────────────────────────────────────────────────────

async def main():
    log.info("Bot started")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
