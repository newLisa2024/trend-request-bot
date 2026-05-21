// assemble_matches.js v3 — сборка матчей + синергия + тексты в одном запуске
//
// Пайплайн:
//   1. Загружает approved кандидатов из match_candidates
//   2. Группирует по парам, считает pair_score + match_score
//   3. Лимит топ-N на резидента
//   4. Сохраняет матчи в БД
//   5. Считает синергию (10 измерений) через Claude
//   6. Генерирует тексты (name, match_reason, pitch_a/b, algo_summary)
//
// Запуск:
//   node assemble_matches.js                           — все пары >= 60
//   RESIDENT_IDS=u1,u2 node assemble_matches.js        — только для резидентов
//   MIN_SCORE=65 node assemble_matches.js              — порог скора (дефолт 60)
//   TOP_N=10 node assemble_matches.js                  — топ на резидента (дефолт 10)
//   DRY_RUN=1 node assemble_matches.js                 — не писать в БД
//   FORCE=1 node assemble_matches.js                   — перезаписать существующие
//   SKIP_SYNERGY=1 node assemble_matches.js            — пропустить синергию
//   SKIP_TEXTS=1 node assemble_matches.js              — пропустить тексты

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://wterixeqalajjxavdiss.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const RESIDENT_IDS   = process.env.RESIDENT_IDS?.split(',').map(s => s.trim()).filter(Boolean);
const MIN_SCORE      = parseFloat(process.env.MIN_SCORE || '60');
const TOP_N          = parseInt(process.env.TOP_N || '10');
const DRY_RUN        = process.env.DRY_RUN === '1';
const FORCE          = process.env.FORCE === '1';
const SKIP_SYNERGY   = process.env.SKIP_SYNERGY === '1';
const SKIP_TEXTS     = process.env.SKIP_TEXTS === '1';
const SYNERGY_BATCH  = parseInt(process.env.SYNERGY_BATCH || '5');
const TEXT_CONCURRENCY = parseInt(process.env.TEXT_CONCURRENCY || '5');
const MODEL          = 'claude-haiku-4-5-20251001';

if (!SUPABASE_KEY) { console.error('SUPABASE_KEY не задан'); process.exit(1); }
if (!SKIP_SYNERGY && !SKIP_TEXTS && !ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY не задан'); process.exit(1); }

const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ── Хелперы ──────────────────────────────────────────────────────────────────

const normKey = (a, b) => a < b ? `${a}__${b}` : `${b}__${a}`;
const trunc = (s, n = 350) => s ? String(s).trim().substring(0, n) : '';
const clamp = (v) => Math.min(100, Math.max(0, parseInt(v) || 0));
const getFirstName = (full = '') => full.trim().split(/\s+/)[0] || 'Резидент';
const fmtRevenue = (v) => {
  if (!v) return null;
  const b = v / 1e9;
  if (b >= 1) return `${Math.round(b * 10) / 10} млрд ₽`;
  return `${Math.round(v / 1e6)} млн ₽`;
};
function getDisplayNames(nameA, nameB) {
  const a = getFirstName(nameA);
  const b = getFirstName(nameB);
  if (a.toLowerCase() === b.toLowerCase()) {
    const la = ((nameA || '').trim().split(/\s+/)[1] || '')[0] || '';
    const lb = ((nameB || '').trim().split(/\s+/)[1] || '')[0] || '';
    return { dA: la ? a + ' ' + la + '.' : a, dB: lb ? b + ' ' + lb + '.' : b };
  }
  return { dA: a, dB: b };
}

// ══════════════════════════════════════════════════════════════════════════════
// ЭТАП 1: Сборка пар из match_candidates
// ══════════════════════════════════════════════════════════════════════════════

async function loadCandidates() {
  let query = supabase
    .from('match_candidates')
    .select('id, resident_a_id, resident_b_id, request_id, expertise_id, final_score, session_id')
    .gte('final_score', MIN_SCORE)
    .eq('status', 'approved')
    .order('final_score', { ascending: false });

  if (RESIDENT_IDS?.length) {
    query = query.or(RESIDENT_IDS.map(id => `resident_a_id.eq.${id},resident_b_id.eq.${id}`).join(','));
  }

  const { data, error } = await query;
  if (error) throw new Error('Ошибка загрузки кандидатов: ' + error.message);

  const candidates = data || [];

  // Загружаем ai_pair_scores и присоединяем
  const reqIds = [...new Set(candidates.map(c => c.request_id).filter(Boolean))];
  const expIds = [...new Set(candidates.map(c => c.expertise_id).filter(Boolean))];

  let aiMap = new Map();
  if (reqIds.length > 0 && expIds.length > 0) {
    const { data: aiData } = await supabase
      .from('ai_pair_scores')
      .select('request_id, expertise_id, score_summary, sphere_reason')
      .in('request_id', reqIds)
      .in('expertise_id', expIds);
    if (aiData) aiData.forEach(a => aiMap.set(`${a.request_id}_${a.expertise_id}`, a));
  }

  return candidates.map(c => ({ ...c, ai_score: aiMap.get(`${c.request_id}_${c.expertise_id}`) ?? null }));
}

const SYNERGY_DIMS = ['cross_sell', 'tech', 'biz_model', 'resource', 'media', 'competence', 'geo', 'strategic', 'values', 'ops'];

async function loadSynergyScores() {
  const fields = ['resident_a_id', 'resident_b_id', 'total_synergy_score',
    ...SYNERGY_DIMS.map(d => `${d}_score`), ...SYNERGY_DIMS.map(d => `${d}_desc`)].join(',');
  const { data, error } = await supabase.from('synergy_scores').select(fields);
  if (error) throw new Error('Ошибка загрузки синергии: ' + error.message);

  const map = new Map();
  for (const r of data || []) {
    const key = normKey(r.resident_a_id, r.resident_b_id);
    const scores = SYNERGY_DIMS.map(d => r[`${d}_score`] || 0).sort((a, b) => b - a);
    map.set(key, { ...r, max_dim: scores[0] || 0 });
  }
  return map;
}

async function loadExistingMatches() {
  const { data } = await supabase.from('matches').select('resident_a_id, resident_b_id').eq('algo_version', 'v2');
  const set = new Set();
  for (const m of data || []) set.add(normKey(m.resident_a_id, m.resident_b_id));
  return set;
}

function assemblePairs(candidates, synergyMap) {
  const pairMap = new Map();

  for (const c of candidates) {
    const key = normKey(c.resident_a_id, c.resident_b_id);
    if (!pairMap.has(key)) {
      pairMap.set(key, { key, a_id: c.resident_a_id, b_id: c.resident_b_id, best_a_to_b: null, best_b_to_a: null });
    }
    const pair = pairMap.get(key);
    const isAtoB = c.resident_a_id === pair.a_id;
    if (isAtoB) {
      if (!pair.best_a_to_b || c.final_score > pair.best_a_to_b.final_score) pair.best_a_to_b = c;
    } else {
      if (!pair.best_b_to_a || c.final_score > pair.best_b_to_a.final_score) pair.best_b_to_a = c;
    }
  }

  const results = [];
  for (const [key, pair] of pairMap) {
    const s_a2b = pair.best_a_to_b?.final_score ?? 0;
    const s_b2a = pair.best_b_to_a?.final_score ?? 0;
    if (s_a2b === 0 && s_b2a === 0) continue;

    const best = s_a2b >= s_b2a ? pair.best_a_to_b : pair.best_b_to_a;
    const top = Math.max(s_a2b, s_b2a);
    const second = Math.min(s_a2b, s_b2a);
    let pair_score = top * 0.6 + second * 0.4;
    if (s_a2b >= 60 && s_b2a >= 60) pair_score = Math.min(100, pair_score * 1.1);
    pair_score = Math.round(pair_score * 10) / 10;

    const synergy = synergyMap.get(key);
    const synergy_total = synergy?.total_synergy_score ?? null;
    let match_score;
    if (synergy_total !== null) {
      const mx = Math.max(pair_score, synergy_total);
      const mn = Math.min(pair_score, synergy_total);
      match_score = Math.min(99, Math.round(mx + mn * 0.1));
    } else {
      match_score = Math.round(pair_score);
    }

    const summary = best?.ai_score?.score_summary || best?.ai_score?.sphere_reason || null;

    results.push({
      resident_a_id: best?.resident_a_id ?? pair.a_id,
      resident_b_id: best?.resident_b_id ?? pair.b_id,
      score: match_score, pair_score,
      score_a_to_b: s_a2b > 0 ? s_a2b : null,
      score_b_to_a: s_b2a > 0 ? s_b2a : null,
      candidate_a_to_b_id: pair.best_a_to_b?.id ?? null,
      candidate_b_to_a_id: pair.best_b_to_a?.id ?? null,
      request_id: best?.request_id ?? null,
      match_reason: summary,
      algo_version: 'v2', status: 'approved',
      _key: key, _a_id: pair.a_id, _b_id: pair.b_id,
    });
  }
  return results;
}

function limitTopN(pairs, topN) {
  const countPerResident = new Map();
  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  const result = [];
  for (const p of sorted) {
    const cA = countPerResident.get(p.resident_a_id) || 0;
    const cB = countPerResident.get(p.resident_b_id) || 0;
    if (cA < topN && cB < topN) {
      result.push(p);
      countPerResident.set(p.resident_a_id, cA + 1);
      countPerResident.set(p.resident_b_id, cB + 1);
    }
  }
  return result;
}

async function saveMatches(pairs) {
  if (DRY_RUN) return { created: pairs.length, skipped: 0, ids: [] };

  if (FORCE) {
    console.log('🗑️  Удаление старых v2 матчей...');
    await supabase.from('matches').delete().eq('algo_version', 'v2');
  }

  const rows = pairs.map(({ _key, _a_id, _b_id, ...rest }) => rest);
  const ids = [];
  let created = 0;

  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { data, error } = await supabase.from('matches').insert(batch).select('id');
    if (error) { console.error('  ✗ Ошибка вставки:', error.message); continue; }
    created += batch.length;
    if (data) ids.push(...data.map(d => d.id));
    process.stdout.write(`\r   Создано: ${created}/${rows.length}   `);
  }
  console.log();
  return { created, skipped: 0, ids };
}

// ══════════════════════════════════════════════════════════════════════════════
// ЭТАП 2: Синергия
// ══════════════════════════════════════════════════════════════════════════════

async function loadResident(id) {
  const { data: r } = await supabase
    .from('residents')
    .select('id, full_name, business_text, expertise_text, interests, values, total_revenue, total_employees, industry_names')
    .eq('id', id).single();
  if (!r) return null;

  const { data: rcIds } = await supabase.from('resident_companies').select('company_id').eq('resident_id', id);
  let company = null;
  if (rcIds?.length) {
    const { data: companies } = await supabase
      .from('companies')
      .select('name, description, clients, market, commercial_strategy, scaling_strategy, gr, international, revenue')
      .in('id', rcIds.map(x => x.company_id))
      .order('revenue', { ascending: false }).limit(1);
    company = companies?.[0] || null;
  }

  const { data: requests } = await supabase
    .from('requests').select('name, req_group')
    .eq('resident_id', id).not('req_group', 'is', null).neq('status', 'archived')
    .order('name').limit(10);

  return { ...r, company, requests: requests || [] };
}

function formatResidentForSynergy(r, displayName) {
  const c = r.company;
  const lines = [
    `Имя: ${displayName}`,
    r.business_text  ? `Бизнес: ${trunc(r.business_text, 400)}` : '',
    r.expertise_text ? `Экспертиза: ${trunc(r.expertise_text, 300)}` : '',
    r.interests      ? `Интересы: ${trunc(r.interests, 200)}` : '',
    r.values         ? `Ценности: ${trunc(r.values, 200)}` : '',
    r.industry_names?.length ? `Отрасли: ${r.industry_names.join(', ')}` : '',
    r.total_revenue  ? `Оборот: ${Math.round(r.total_revenue / 1e6)} млн ₽` : '',
    r.total_employees ? `Команда: ${r.total_employees} чел` : '',
  ];
  if (c) {
    lines.push(`\nКомпания: ${c.name}`);
    if (c.description)         lines.push(`  Описание: ${trunc(c.description, 300)}`);
    if (c.clients)             lines.push(`  Клиенты: ${trunc(c.clients, 250)}`);
    if (c.market)              lines.push(`  Рынок: ${trunc(c.market, 250)}`);
    if (c.commercial_strategy) lines.push(`  Коммерция: ${trunc(c.commercial_strategy, 250)}`);
    if (c.scaling_strategy)    lines.push(`  Масштабирование: ${trunc(c.scaling_strategy, 250)}`);
  }
  if (r.requests.length) {
    lines.push(`\nЗапросы:`);
    r.requests.forEach(req => lines.push(`  - [${req.req_group}] ${req.name}`));
  }
  return lines.filter(Boolean).join('\n');
}

function buildSynergyPrompt(pairs) {
  const pairsBlock = pairs.map((p, i) => {
    const { dA, dB } = getDisplayNames(p.a.full_name, p.b.full_name);
    return `=== ПАРА ${i + 1} (id: ${p.a.id}__${p.b.id}) ===
РЕЗИДЕНТ А:\n${formatResidentForSynergy(p.a, dA)}

РЕЗИДЕНТ Б:\n${formatResidentForSynergy(p.b, dB)}`;
  }).join('\n\n');

  return `Ты оцениваешь БИЗНЕС-СИНЕРГИЮ пар резидентов закрытого бизнес-сообщества.
Для каждой пары оцени 10 типов синергии по шкале 0–100.

ВАЖНО:
- Оценивай конкретную практическую пользу, а не общие слова
- 0 = никакой синергии | 30-50 = теоретически | 60-80 = конкретные основания | 80-100 = сильная
- Мягкие формулировки. Только имена, без фамилий.

${pairsBlock}

=== 10 ТИПОВ СИНЕРГИИ ===
1. cross_sell — Кросс-продажи (продавать друг другу / клиентам друг друга)
2. tech — Комплементарные технологии
3. biz_model — Схожесть бизнес-моделей, обмен опытом масштабирования
4. resource — Дефицит vs избыток ресурсов
5. media — Маркетинговое/медийное объединение
6. competence — Комплементарные компетенции
7. geo — Географическая синергия
8. strategic — Стратегическая синергия (GR, дистрибуция, совместные проекты)
9. values — Ценностная синергия
10. ops — Операционная синергия

=== ОТВЕТ ===
JSON-массив ровно из ${pairs.length} объектов:
[{"pair_id":"uuid_a__uuid_b","cross_sell_score":0-100,"cross_sell_desc":"...","tech_score":0-100,"tech_desc":"...","biz_model_score":0-100,"biz_model_desc":"...","resource_score":0-100,"resource_desc":"...","media_score":0-100,"media_desc":"...","competence_score":0-100,"competence_desc":"...","geo_score":0-100,"geo_desc":"...","strategic_score":0-100,"strategic_desc":"...","values_score":0-100,"values_desc":"...","ops_score":0-100,"ops_desc":"...","total_synergy_score":0-100}]
total_synergy_score = среднее из 3 лучших шкал. Ровно ${pairs.length} объектов.`;
}

async function runSynergyScoring(matchPairs, synergyMap) {
  if (!anthropic) { console.log('  ⚠ ANTHROPIC_API_KEY не задан, пропуск синергии'); return synergyMap; }

  // Собираем пары, для которых нет синергии
  const toScore = [];
  const residentCache = new Map();

  async function getResident(id) {
    if (!residentCache.has(id)) residentCache.set(id, await loadResident(id));
    return residentCache.get(id);
  }

  for (const p of matchPairs) {
    const key = normKey(p.resident_a_id, p.resident_b_id);
    if (!FORCE && synergyMap.has(key)) continue;
    try {
      const [a, b] = await Promise.all([getResident(p.resident_a_id), getResident(p.resident_b_id)]);
      if (a && b) toScore.push({ a, b, key });
    } catch (e) {
      console.error(`  ✗ Загрузка ${p.resident_a_id.slice(0,8)}×${p.resident_b_id.slice(0,8)}: ${e.message}`);
    }
  }

  console.log(`   Пар для синергии: ${toScore.length}`);
  if (!toScore.length) return synergyMap;

  let saved = 0, errors = 0;
  for (let i = 0; i < toScore.length; i += SYNERGY_BATCH) {
    const batch = toScore.slice(i, i + SYNERGY_BATCH);
    try {
      const prompt = buildSynergyPrompt(batch);
      const msg = await anthropic.messages.create({
        model: MODEL, max_tokens: Math.min(16000, batch.length * 1800 + 800),
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text?.trim() || '';
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('Не JSON');
      const results = JSON.parse(match[0]);
      const resultMap = new Map(results.map(r => [r.pair_id, r]));

      for (const p of batch) {
        const r = resultMap.get(`${p.a.id}__${p.b.id}`);
        if (!r) { errors++; continue; }
        const [norm_a, norm_b] = p.a.id < p.b.id ? [p.a.id, p.b.id] : [p.b.id, p.a.id];
        const row = { resident_a_id: norm_a, resident_b_id: norm_b, model: MODEL, prompt_version: 'synergy-v1', updated_at: new Date().toISOString() };
        for (const dim of SYNERGY_DIMS) {
          row[`${dim}_score`] = clamp(r[`${dim}_score`]);
          row[`${dim}_desc`] = trunc(r[`${dim}_desc`], 500);
        }
        row.total_synergy_score = clamp(r.total_synergy_score);

        if (!DRY_RUN) {
          await supabase.from('synergy_scores').upsert(row, { onConflict: 'resident_a_id,resident_b_id' });
        }
        synergyMap.set(p.key, { ...row, max_dim: SYNERGY_DIMS.map(d => row[`${d}_score`]).sort((a,b) => b - a)[0] });
        saved++;
      }
    } catch (e) {
      console.error(`  ✗ Батч синергии: ${e.message}`);
      errors += batch.length;
    }
    process.stdout.write(`\r   Синергия: ${saved + errors}/${toScore.length} (ok=${saved}, err=${errors})   `);
    if (i + SYNERGY_BATCH < toScore.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log();
  return synergyMap;
}

// ══════════════════════════════════════════════════════════════════════════════
// ЭТАП 3: Генерация текстов
// ══════════════════════════════════════════════════════════════════════════════

async function generateMatchTexts(matchIds, synergyMap) {
  if (!anthropic) { console.log('  ⚠ ANTHROPIC_API_KEY не задан, пропуск текстов'); return; }

  const { data: matches, error } = await supabase
    .from('matches')
    .select(`id, score, pair_score, resident_a_id, resident_b_id, request_id,
      resident_a:residents!matches_resident_a_id_fkey(full_name, business_text, expertise_text, total_revenue, total_employees, industry_names, values, interests, key_achievements),
      resident_b:residents!matches_resident_b_id_fkey(full_name, business_text, expertise_text, total_revenue, total_employees, industry_names, values, interests, key_achievements),
      request:requests!matches_request_id_fkey(name, description, req_group)`)
    .in('id', matchIds);

  if (error || !matches?.length) { console.log('  Нет матчей для текстов'); return; }
  console.log(`   Матчей для текстов: ${matches.length}`);

  let done = 0, errors = 0;
  for (let i = 0; i < matches.length; i += TEXT_CONCURRENCY) {
    const chunk = matches.slice(i, i + TEXT_CONCURRENCY);

    await Promise.all(chunk.map(async (m) => {
      const a = m.resident_a;
      const b = m.resident_b;
      if (!a || !b) return;

      const { dA, dB } = getDisplayNames(a.full_name, b.full_name);
      const synKey = [m.resident_a_id, m.resident_b_id].sort().join('__');
      const syn = synergyMap.get(synKey);

      const synBlock = syn ? `
Синергия (${syn.total_synergy_score}%):
  Кросс-продажи: ${trunc(syn.cross_sell_desc, 200)}
  Технологии: ${trunc(syn.tech_desc, 200)}
  Компетенции: ${trunc(syn.competence_desc, 200)}
  Стратегия: ${trunc(syn.strategic_desc, 200)}
  Ценности: ${trunc(syn.values_desc, 200)}` : '';

      const prompt = `Ты составляешь описание для карточки бизнес-матча между двумя предпринимателями.

РЕЗИДЕНТ А — ${dA}:
  Бизнес: ${trunc(a.business_text, 300)}
  Экспертиза: ${trunc(a.expertise_text, 250)}
  Оборот: ${fmtRevenue(a.total_revenue) || 'не указан'} · ${a.total_employees || '?'} чел.
  Отрасли: ${a.industry_names?.join(', ') || ''}

РЕЗИДЕНТ Б — ${dB}:
  Бизнес: ${trunc(b.business_text, 300)}
  Экспертиза: ${trunc(b.expertise_text, 250)}
  Оборот: ${fmtRevenue(b.total_revenue) || 'не указан'} · ${b.total_employees || '?'} чел.
  Отрасли: ${b.industry_names?.join(', ') || ''}

${m.request ? `Запрос А: ${m.request.name} (${m.request.req_group})\n  ${trunc(m.request.description, 250)}` : ''}
${synBlock}

Скор матча: ${m.score}%

Сформируй 6 полей. Используй только имена (${dA} и ${dB}), без фамилий.
ВАЖНО: только мягкие формулировки — "возможно", "потенциально", "есть вероятность", "стоит обсудить", "скорее всего".

Верни ТОЛЬКО JSON:
{
  "name": "Короткое яркое название матча (3-6 слов, суть синергии, без имён)",
  "match_reason": "Одно предложение — почему потенциально стоит встретиться. Используй имена.",
  "common_intersections": "2-3 предложения — что общего: ценности/опыт/отрасли/масштаб. Используй имена.",
  "pitch_a": "Одно предложение — что потенциально может получить ${dA} от встречи с ${dB}.",
  "pitch_b": "Одно предложение — что потенциально может получить ${dB} от встречи с ${dA}.",
  "algo_summary": ["Возможно, ...","Потенциально ...","Есть вероятность ...","Стоит обсудить ...","Скорее всего ..."]
}
algo_summary — массив ровно из 5 коротких гипотез о синергиях. Каждая начинается с разного вводного слова. Используй имена.`;

      try {
        const msg = await anthropic.messages.create({
          model: MODEL, max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        });
        const raw = msg.content[0]?.text?.trim() || '';
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Не JSON');
        const texts = JSON.parse(jsonMatch[0]);

        if (!DRY_RUN) {
          await supabase.from('matches').update({
            name:                 texts.name?.substring(0, 150),
            match_reason:         texts.match_reason?.substring(0, 300),
            common_intersections: texts.common_intersections?.substring(0, 500),
            pitch_a:              texts.pitch_a?.substring(0, 300),
            pitch_b:              texts.pitch_b?.substring(0, 300),
            algo_summary:         Array.isArray(texts.algo_summary) ? texts.algo_summary : null,
          }).eq('id', m.id);
        }
        done++;
      } catch (e) {
        errors++;
        console.error(`\n  ✗ ${m.id.slice(0,8)}: ${e.message?.substring(0, 80)}`);
      }
      process.stdout.write(`\r   Тексты: ${done + errors}/${matches.length} (ok=${done}, err=${errors})   `);
    }));

    if (i + TEXT_CONCURRENCY < matches.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log();
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n🔀 assemble_matches.js v3${DRY_RUN ? ' [DRY RUN]' : ''}${FORCE ? ' [FORCE]' : ''}`);
  console.log(`   Порог: ${MIN_SCORE} · Топ-N: ${TOP_N}${SKIP_SYNERGY ? ' · SKIP_SYNERGY' : ''}${SKIP_TEXTS ? ' · SKIP_TEXTS' : ''}\n`);

  // ── ЭТАП 1: Сборка ──────────────────────────────────────────────────────────

  console.log('📊 Загрузка кандидатов...');
  const candidates = await loadCandidates();
  console.log(`   Кандидатов (approved, >= ${MIN_SCORE}): ${candidates.length}`);
  if (!candidates.length) { console.log('   Нет кандидатов.'); return; }

  console.log('🔗 Загрузка синергии...');
  let synergyMap = await loadSynergyScores();
  console.log(`   Пар с синергией: ${synergyMap.size}`);

  console.log('📋 Загрузка существующих матчей...');
  const existingSet = await loadExistingMatches();
  console.log(`   Существующих v2 матчей: ${existingSet.size}\n`);

  console.log('⚙️  Сборка пар...');
  const assembled = assemblePairs(candidates, synergyMap);
  console.log(`   Уникальных пар: ${assembled.length}`);

  const limited = limitTopN(assembled, TOP_N);
  console.log(`   После лимита топ-${TOP_N}: ${limited.length}`);

  const avgScore = limited.length ? Math.round(limited.reduce((s, p) => s + p.score, 0) / limited.length * 10) / 10 : 0;
  console.log(`   Средний скор: ${avgScore}\n`);

  // Фильтруем уже существующие
  const newPairs = FORCE ? limited : limited.filter(p => !existingSet.has(normKey(p.resident_a_id, p.resident_b_id)));
  if (!newPairs.length && !FORCE) { console.log('   Все матчи уже созданы.'); return; }

  console.log('💾 Создание матчей...');
  const { created, ids } = await saveMatches(newPairs);
  console.log(`   Создано: ${created}\n`);

  if (created === 0 || DRY_RUN) return;

  // ── ЭТАП 2: Синергия ────────────────────────────────────────────────────────

  if (!SKIP_SYNERGY) {
    console.log('🔄 Синергия...');
    synergyMap = await runSynergyScoring(newPairs, synergyMap);

    // Пересчитываем match_score с учётом новой синергии
    console.log('📐 Пересчёт match_score с синергией...');
    let updated = 0;
    for (const p of newPairs) {
      const key = normKey(p.resident_a_id, p.resident_b_id);
      const syn = synergyMap.get(key);
      if (!syn) continue;
      const synTotal = syn.total_synergy_score;
      const newScore = Math.min(99, Math.round(Math.max(p.pair_score, synTotal) + Math.min(p.pair_score, synTotal) * 0.1));
      if (newScore !== p.score) {
        const matchId = ids[newPairs.indexOf(p)];
        if (matchId) {
          await supabase.from('matches').update({ score: newScore }).eq('id', matchId);
          updated++;
        }
      }
    }
    console.log(`   Обновлено скоров: ${updated}\n`);
  }

  // ── ЭТАП 3: Тексты ─────────────────────────────────────────────────────────

  if (!SKIP_TEXTS && ids.length) {
    console.log('✍️  Генерация текстов...');
    await generateMatchTexts(ids, synergyMap);
  }

  console.log(`\n✅ Готово! Создано ${created} матчей.`);
}

main().catch(err => { console.error('\n💥 Fatal:', err.message); process.exit(1); });
