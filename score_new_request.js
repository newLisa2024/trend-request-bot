// score_new_request.js — скоринг одного нового запроса
//
// Запуск:
//   REQUEST_ID=uuid node --env-file=.env score_new_request.js
//   VECTOR_LIMIT=40 REQUEST_ID=uuid node --env-file=.env score_new_request.js
//   DRY_RUN=1 REQUEST_ID=uuid node --env-file=.env score_new_request.js
//
// Что делает:
//   1. Загружает один запрос по REQUEST_ID
//   2. Находит топ-N похожих экспертиз через vector_filter_expertises
//   3. Скорит пары запрос↔экспертиза через Claude
//   4. Сохраняет в ai_pair_scores
//   5. Вызывает calculate_final_scores

import { createClient } from '@supabase/supabase-js';
import Anthropic        from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://wterixeqalajjxavdiss.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REQUEST_ID    = process.env.REQUEST_ID;
const DRY_RUN       = process.env.DRY_RUN === '1';
const FORCE         = process.env.FORCE === '1';
const VECTOR_LIMIT  = parseInt(process.env.VECTOR_LIMIT || '40');
const BATCH_SIZE    = Math.min(parseInt(process.env.BATCH_SIZE || '20'), 30);
const CONCURRENCY   = parseInt(process.env.CONCURRENCY || '3');
const MODEL         = 'claude-haiku-4-5-20251001';

if (!SUPABASE_KEY)  { console.error('❌ SUPABASE_KEY не задан');       process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('❌ ANTHROPIC_API_KEY не задан');  process.exit(1); }
if (!REQUEST_ID)    { console.error('❌ REQUEST_ID не задан\n   Использование: REQUEST_ID=uuid node --env-file=.env score_new_request.js'); process.exit(1); }

const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFirstName(fullName) {
  return ((fullName || '').trim().split(/\s+/)[0]) || 'Резидент';
}

function getDisplayNames(nameA, nameB) {
  const a = getFirstName(nameA);
  const b = getFirstName(nameB);
  if (a.toLowerCase() === b.toLowerCase()) {
    const la = ((nameA || '').trim().split(/\s+/)[1] || '')[0] || '';
    const lb = ((nameB || '').trim().split(/\s+/)[1] || '')[0] || '';
    return { displayA: la ? `${a} ${la}.` : a, displayB: lb ? `${b} ${lb}.` : b };
  }
  return { displayA: a, displayB: b };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms))
  ]);
}

// ── Промпт ────────────────────────────────────────────────────────────────────

function loadPromptTemplate() {
  const raw = readFileSync(join(__dirname, 'prompt_scoring_v1.md'), 'utf8');
  return raw.replace(/^---[\s\S]*?---\n?/, '').trim();
}

function buildBatchPrompt(request, expertises, residentAName) {
  const firstName = getFirstName(residentAName);

  const expBlock = expertises.map((e, i) => {
    const res = e.residents?.[0]?.residents || {};
    const { displayA, displayB } = getDisplayNames(residentAName, res.full_name || '');
    const lines = [
      `--- ЭКСПЕРТИЗА ${i+1} (id: ${e.id}) ---`,
      `Резидент А: ${displayA}`,
      `Резидент Б: ${displayB}`,
      `Название: ${e.name || ''}`,
      `Область (area): ${e.area || ''}`,
      `Подобласть (sub_area): ${e.sub_area || ''}`,
      `Уровень: ${e.level || 'не заполнен'}`,
      `Описание: ${e.full_description || '(нет)'}`,
    ];
    if (e.cases)          lines.push(`Кейсы: ${e.cases}`);
    if (e.interview_text) lines.push(`Цитата: "${e.interview_text}"`);
    lines.push(`Бизнес Б: ${res.business_text || '(нет)'}`);
    lines.push(`Профиль Б: ${res.expertise_text || '(нет)'}`);
    return lines.join('\n');
  }).join('\n\n');

  const metaLines = [];
  if (request.req_goal)          metaLines.push(`Цель: ${request.req_goal}`);
  if (request.req_area?.length)  metaLines.push(`Область: ${Array.isArray(request.req_area)  ? request.req_area.join(', ')  : request.req_area}`);
  if (request.req_niche?.length) metaLines.push(`Ниша: ${Array.isArray(request.req_niche) ? request.req_niche.join(', ') : request.req_niche}`);

  const template = loadPromptTemplate();
  const dataBlock =
    `═══ ЗАПРОС (${firstName}) ═══\n` +
    `Название: ${request.name}\n` +
    metaLines.join('\n') + '\n' +
    `Описание: ${request.description || '(нет)'}\n\n` +
    `═══ ЭКСПЕРТИЗЫ (${expertises.length} штук) ═══\n` +
    expBlock;

  const answerBlock =
    `═══ ОТВЕТ ═══\n` +
    `Верни JSON-массив ровно из ${expertises.length} объектов:\n` +
    `[\n  {\n` +
    `    "expertise_id": "uuid",\n` +
    `    "product_score": 0-100,\n` +
    `    "product_reason": "одно предложение",\n` +
    `    "expertise_score": 0-100,\n` +
    `    "expertise_reason": "одно предложение",\n` +
    `    "score_summary": "одно предложение — почему предположительно встреча может состояться"\n` +
    `  }\n]\n` +
    `Ровно ${expertises.length} объектов.\n` +
    `Используй только имена (без фамилий). Мягкие формулировки: возможно, потенциально, есть вероятность.`;

  return template.replace('{DATA}', dataBlock).replace('{ANSWER}', answerBlock);
}

// ── DB operations ─────────────────────────────────────────────────────────────

async function vectorFilter(requestId, residentId) {
  const { data, error } = await supabase.rpc('vector_filter_expertises', {
    p_request_id:  requestId,
    p_resident_id: residentId,
    p_limit:       VECTOR_LIMIT,
  });
  if (error) throw new Error(`vector_filter: ${error.message}`);
  return data || [];
}

async function getCachedIds(requestId, expertiseIds) {
  if (FORCE) return new Set();
  const { data } = await supabase.from('ai_pair_scores')
    .select('expertise_id').eq('request_id', requestId).in('expertise_id', expertiseIds);
  return new Set((data || []).map(r => r.expertise_id));
}

async function loadExpertiseBatch(expertiseIds, attempt = 1) {
  try {
    const { data, error } = await withTimeout(
      supabase.from('expertise')
        .select('id,name,full_description,cases,interview_text,area,sub_area,level,resident_expertise!inner(resident_id),residents:resident_expertise!inner(residents(id,full_name,business_text,expertise_text,strengths))')
        .in('id', expertiseIds),
      20000, 'loadExpertiseBatch'
    );
    if (error) throw new Error(error.message);
    return data || [];
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return loadExpertiseBatch(expertiseIds, attempt + 1);
    }
    console.error(`\n  Пропуск батча (3 попытки): ${e.message}`);
    return [];
  }
}

async function ensureSession(requestId, residentId, expIds) {
  const { data: existing } = await supabase
    .from('scoring_sessions')
    .select('id')
    .eq('request_id', requestId)
    .eq('resident_a_id', residentId)
    .limit(1);

  if (existing?.length) {
    await supabase.from('scoring_sessions').update({
      filter_exp_ids:   expIds,
      filter_exp_count: expIds.length,
      status:           'filter',
      updated_at:       new Date().toISOString(),
    }).eq('id', existing[0].id);
    return existing[0].id;
  }

  const { data, error } = await supabase.from('scoring_sessions').insert({
    request_id:       requestId,
    resident_a_id:    residentId,
    filter_exp_ids:   expIds,
    filter_exp_count: expIds.length,
    status:           'filter',
  }).select('id').single();
  if (error) throw error;
  return data.id;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

async function scoreBatch(request, expertises, residentAName, retries = 2) {
  const prompt    = buildBatchPrompt(request, expertises, residentAName);
  const maxTokens = Math.min(8192, expertises.length * 350 + 800);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: MODEL, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw      = msg.content[0]?.text?.trim() || '';
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '');
      const match    = stripped.match(/\[[\s\S]*\]/);
      if (!match) throw new Error(`Не JSON-массив: ${raw.substring(0, 100)}`);
      const results = JSON.parse(match[0]);
      if (results.length < expertises.length) {
        console.warn(`  ⚠ AI вернул ${results.length}/${expertises.length} — используем что есть`);
      }
      return expertises.map((e, i) => {
        const r = results[i];
        if (!r) return {
          expertise_id: e.id, sphere_score: 0, sphere_reason: 'нет ответа',
          expertise_score: 0, expertise_reason: 'нет ответа', score_summary: '',
        };
        const isProductArea = /продукт|услуг/i.test(e.area || '');
        const rawSphere = Math.min(100, Math.max(0, parseInt(r.product_score) || 0));
        return {
          expertise_id:     e.id,
          sphere_score:     isProductArea ? rawSphere : Math.min(rawSphere, 50),
          sphere_reason:    r.product_reason   || '',
          expertise_score:  Math.min(100, Math.max(0, parseInt(r.expertise_score) || 0)),
          expertise_reason: r.expertise_reason || '',
          score_summary:    r.score_summary    || '',
        };
      });
    } catch (err) {
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
      else {
        console.error(`\n  ✗ scoreBatch: ${err.message.substring(0, 80)}`);
        return expertises.map(e => ({
          expertise_id: e.id, sphere_score: 0, sphere_reason: 'ошибка AI',
          expertise_score: 0, expertise_reason: 'ошибка AI', score_summary: '',
        }));
      }
    }
  }
}

async function saveResults(requestId, expertises, scores) {
  if (DRY_RUN) return { saved: scores.length, errors: 0 };

  const rows = scores.map(s => ({
    request_id:       requestId,
    expertise_id:     s.expertise_id,
    sphere_score:     s.sphere_score,
    sphere_reason:    s.sphere_reason,
    expertise_score:  s.expertise_score,
    expertise_reason: s.expertise_reason,
    score_summary:    s.score_summary,
    model:            MODEL,
  }));

  const { error } = await supabase.from('ai_pair_scores')
    .upsert(rows, { onConflict: 'request_id,expertise_id' });

  if (error) {
    console.error(`\n  ✗ saveResults: ${error.message}`);
    return { saved: 0, errors: rows.length };
  }
  return { saved: rows.length, errors: 0 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 score_new_request.js`);
  console.log(`   Модель: ${MODEL}`);
  console.log(`   Вектор: топ-${VECTOR_LIMIT} экспертиз`);
  console.log(DRY_RUN ? '   [DRY RUN — без записи в БД]' : '');
  console.log(FORCE   ? '   [FORCE — игнорировать кэш]' : '');
  console.log();

  // 1. Загружаем запрос
  const { data: request, error: reqErr } = await supabase
    .from('requests')
    .select('id, name, resident_id, req_group, req_area, req_niche, req_goal, description, embedding')
    .eq('id', REQUEST_ID)
    .single();

  if (reqErr || !request) {
    console.error(`❌ Запрос не найден: ${reqErr?.message || 'нет данных'}`);
    process.exit(1);
  }

  if (!request.embedding) {
    console.error('❌ У запроса нет эмбеддинга. Сначала запусти генерацию эмбеддинга.');
    process.exit(1);
  }

  // 2. Загружаем резидента А
  const { data: resident } = await supabase
    .from('residents')
    .select('full_name')
    .eq('id', request.resident_id)
    .single();

  const residentName = resident?.full_name || 'Резидент';

  console.log(`👤 Резидент А: ${residentName}`);
  console.log(`📋 Запрос: ${request.name}`);
  console.log(`🏷  Группа: ${request.req_group || '—'}\n`);

  // 3. Векторный фильтр — топ-N похожих экспертиз
  process.stdout.write('🔍 Векторный фильтр...');
  const vectorResults = await vectorFilter(request.id, request.resident_id);

  if (!vectorResults.length) {
    console.log(' 0 совпадений. Нечего скорить.');
    process.exit(0);
  }

  const topSim  = (vectorResults[0].similarity * 100).toFixed(1);
  const botSim  = (vectorResults[vectorResults.length-1].similarity * 100).toFixed(1);
  const uniqRes = new Set(vectorResults.map(v => v.owner_name)).size;
  console.log(` ${vectorResults.length} экспертиз (${topSim}%–${botSim}%), ${uniqRes} резидентов Б\n`);

  // 4. Кэш
  const allExpIds = vectorResults.map(v => v.expertise_id);
  const sessionId = await ensureSession(request.id, request.resident_id, allExpIds);
  const cached    = await getCachedIds(request.id, allExpIds);
  const toScore   = allExpIds.filter(id => !cached.has(id));

  console.log(`📊 Экспертиз: ${allExpIds.length} найдено · ${cached.size} в кэше · ${toScore.length} к скорингу`);

  if (toScore.length === 0) {
    console.log('   Всё в кэше, применяю веса...');
    if (!DRY_RUN) {
      const { error } = await supabase.rpc('calculate_final_scores', { p_session_id: sessionId });
      if (error) console.error(`✗ calculate_final_scores: ${error.message}`);
      else console.log('✅ Веса применены\n');
    }
    return;
  }

  // 5. Скоринг батчами
  console.log('\n🤖 Скоринг...\n');
  const batches = [];
  for (let i = 0; i < toScore.length; i += BATCH_SIZE) batches.push(toScore.slice(i, i + BATCH_SIZE));

  let saved = 0, errors = 0;

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async batchIds => {
      const expertises = await loadExpertiseBatch(batchIds);
      const scores     = await scoreBatch(request, expertises, residentName);
      return saveResults(request.id, expertises, scores);
    }));
    results.forEach(r => { saved += r.saved; errors += r.errors; });
    const done = saved + errors + cached.size;
    process.stdout.write(`\r   ${done}/${allExpIds.length} (${Math.round(done/allExpIds.length*100)}%) ok=${saved} cache=${cached.size} err=${errors}   `);
    if (i + CONCURRENCY < batches.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log();

  // 6. Финальный расчёт весов
  if (errors > 0) {
    console.log(`\n⚠️  Есть ошибки (${errors}), пропускаю calculate_final_scores`);
  } else if (!DRY_RUN) {
    process.stdout.write('\n⚙️  Применяю веса (calculate_final_scores)...');
    const { error } = await supabase.rpc('calculate_final_scores', { p_session_id: sessionId });
    if (error) console.log(` ✗ ${error.message}`);
    else console.log(' ✓ done');
  }

  console.log(`\n✅ Готово! Запрос "${request.name}" проскорен.`);
  console.log(`   Сохранено пар: ${saved} · Ошибок: ${errors}\n`);
  console.log(`Следующий шаг — запусти матчинг для резидента:`);
  console.log(`  RESIDENT_IDS=${request.resident_id} node --env-file=.env assemble_matches.js\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
