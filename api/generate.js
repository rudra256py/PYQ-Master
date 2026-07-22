// ════════════════════════════════════════════════════════════
// api/generate.js — Backend with question caching + real PYQ pool
//
// FLOW ON EVERY REQUEST:
//  1. Look in Supabase for real admin-uploaded PYQs (pyq_uploads table)
//  2. Look in Supabase for previously AI-generated questions (questions_cache)
//  3. If (1)+(2) together give enough questions → return them, skip Gemini
//     entirely (this is the "reuse, don't regenerate" behaviour requested)
//  4. If not enough → call Gemini for the shortfall, save new ones into
//     questions_cache so the NEXT user gets them for free from the DB
//
// If Supabase env vars are not set, this file falls back to calling
// Gemini every time (exactly like before) — nothing breaks.
// ════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { prompt, lang, examId, subjects, chapters, count } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Invalid request — missing prompt" });
  }
  const wantCount = Number(count) > 0 ? Number(count) : 50;

  const apiKey   = process.env.GEMINI_API_KEY;
  const supaUrl  = process.env.SUPABASE_URL;
  const supaKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Supabase is OPTIONAL — site still works (always calls Gemini) if not set up yet
  let supabase = null;
  if (supaUrl && supaKey) {
    try { supabase = createClient(supaUrl, supaKey); }
    catch (e) { console.warn("Supabase init failed:", e.message); }
  }

  const subjectKey = (Array.isArray(subjects) && subjects.length) ? [...subjects].sort().join('|') : 'all';
  const chapterKey = (Array.isArray(chapters) && chapters.length) ? [...chapters].sort().join('|') : 'all';
  const wantHalf   = Math.floor(wantCount / 2);

  let pyqPool = [];
  let cachePool = [];

  // ── STEP 1 + 2: Pull whatever we already have from the database ──
  if (supabase && examId) {
    try {
      const { data: pyqRows } = await supabase
        .from('pyq_uploads')
        .select('*')
        .eq('exam_id', examId)
        .eq('lang', lang || 'en')
        .limit(300);
      if (pyqRows) {
        pyqPool = pyqRows.map(r => ({
          q: r.q, opts: r.opts, ans: r.ans, exp: r.exp || '',
          type: 'pyq',
          source: r.year ? `${examId.toUpperCase()} ${r.year}` : `${examId.toUpperCase()}`,
          subject: r.subject || '',
        }));
      }
    } catch (e) { console.warn("pyq_uploads read failed:", e.message); }

    try {
      const { data: cacheRows } = await supabase
        .from('questions_cache')
        .select('*')
        .eq('exam_id', examId)
        .eq('lang', lang || 'en')
        .eq('subject_key', subjectKey)
        .eq('chapter_key', chapterKey)
        .limit(400);
      if (cacheRows) cachePool = cacheRows.map(r => r.question);
    } catch (e) { console.warn("questions_cache read failed:", e.message); }
  }

  pyqPool   = shuffle(pyqPool);
  cachePool = shuffle(cachePool);

  const chosenPyq = pyqPool.slice(0, wantHalf);
  const chosenAi  = cachePool.slice(0, wantCount - chosenPyq.length);
  let finalQs     = shuffle([...chosenPyq, ...chosenAi]);

  // ── STEP 3: Enough already in the database? Skip Gemini completely ──
  if (finalQs.length >= wantCount) {
    return res.status(200).json({
      questions: finalQs.slice(0, wantCount),
      source: 'database',
      lang,
    });
  }

  // ── STEP 4: Not enough — call Gemini for the shortfall ──
  if (!apiKey) {
    // No Gemini key AND not enough DB questions — return what we have (may be short)
    if (finalQs.length > 0) {
      return res.status(200).json({ questions: finalQs, source: 'database-partial', lang });
    }
    return res.status(500).json({ error: "GEMINI_API_KEY not set and no cached questions available." });
  }

  let generated = [];
  let lastError = "";

  for (const model of MODELS) {
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const geminiRes = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8000 },
        }),
      });
      const geminiData = await geminiRes.json();

      if (!geminiRes.ok) {
        lastError = `${model}: ${geminiRes.status} — ${geminiData?.error?.message || ''}`;
        console.warn(lastError);
        continue;
      }

      const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!raw) { lastError = `${model}: empty response`; continue; }

      const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) { lastError = `${model}: no JSON array found`; continue; }

      const qs = JSON.parse(match[0]);
      const valid = (qs || []).filter(q =>
        q && typeof q.q === "string" && q.q.length > 3 &&
        Array.isArray(q.opts) && q.opts.length >= 2 &&
        typeof q.ans === "number" && q.ans >= 0 && q.ans < q.opts.length
      );

      if (valid.length === 0) { lastError = `${model}: invalid question format`; continue; }

      generated = valid;
      console.log(`✅ Gemini success with ${model}: ${valid.length} questions`);
      break;

    } catch (err) {
      lastError = `${model}: ${err.message}`;
      console.warn(lastError);
      continue;
    }
  }

  if (generated.length === 0 && finalQs.length === 0) {
    return res.status(502).json({
      error: "AI service unavailable. Please try again in a moment.",
      detail: lastError,
    });
  }

  // ── Save newly generated AI questions to cache so future users reuse them ──
  if (supabase && generated.length && examId) {
    try {
      const rows = generated.map(q => ({
        exam_id: examId,
        lang: lang || 'en',
        subject_key: subjectKey,
        chapter_key: chapterKey,
        question: q,
        q_type: q.type || 'ai',
      }));
      await supabase.from('questions_cache').insert(rows);
    } catch (e) { console.warn("questions_cache insert failed:", e.message); }
  }

  finalQs = shuffle([...finalQs, ...generated]).slice(0, wantCount);

  return res.status(200).json({
    questions: finalQs,
    source: finalQs.length && generated.length ? 'mixed' : (generated.length ? 'gemini' : 'database'),
    lang,
  });
}
