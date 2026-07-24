-- ════════════════════════════════════════════════════════════
-- PYQ Master — Supabase Database Setup
-- Run this ONCE in Supabase → SQL Editor → New Query → Run
-- ════════════════════════════════════════════════════════════

-- Table 1: Cache of AI-generated questions.
-- Once generated for one user, future users with the same exam +
-- subjects + chapters + language get these instantly, no AI call.
create table if not exists questions_cache (
  id           bigint generated always as identity primary key,
  exam_id      text not null,
  lang         text not null,
  subject_key  text not null,
  chapter_key  text not null,
  question     jsonb not null,
  q_type       text not null default 'ai',
  created_at   timestamptz not null default now()
);

create index if not exists idx_cache_lookup
  on questions_cache (exam_id, lang, subject_key, chapter_key);

-- Table 2: Real Previous Year Questions you upload yourself.
-- Add rows here directly in Supabase → Table Editor → pyq_uploads → Insert row
-- exam_id must match an id from your EXAMS list in index.html (e.g. 'nda','cds','upsc')
-- opts must be a JSON array of 4 strings, e.g. ["Option A","Option B","Option C","Option D"]
-- ans is the 0-based index of the correct option (0,1,2, or 3)
create table if not exists pyq_uploads (
  id           bigint generated always as identity primary key,
  exam_id      text not null,
  lang         text not null default 'en',
  subject      text,
  chapter      text,
  q            text not null,
  opts         jsonb not null,
  ans          int not null,
  exp          text,
  year         text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_pyq_lookup
  on pyq_uploads (exam_id, lang);

-- Security: lock both tables down from direct public (anon key) access.
-- Your backend uses the SERVICE ROLE key, which bypasses this automatically.
alter table questions_cache enable row level security;
alter table pyq_uploads enable row level security;

drop policy if exists "no public access" on questions_cache;
create policy "no public access" on questions_cache for all using (false);

drop policy if exists "no public access" on pyq_uploads;
create policy "no public access" on pyq_uploads for all using (false);

-- ════════════════════════════════════════════════════════════
-- Done! Two tables created:
--   questions_cache  → fills up automatically as users take quizzes
--   pyq_uploads      → you fill this manually with real PYQs you have
-- ════════════════════════════════════════════════════════════
