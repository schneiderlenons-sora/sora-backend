-- =====================================================================
-- 043 — Relatos de bug enviados pelos usuários (aba "Relatar um problema").
-- O relato cai no WhatsApp de suporte via Z-API; esta tabela é o histórico.
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.bug_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete set null,
  nome        text,
  phone       text,
  email       text,
  mensagem    text not null,
  tem_imagem  boolean default false,
  status      text default 'aberto' check (status in ('aberto','em_andamento','resolvido')),
  created_at  timestamptz default now()
);

create index if not exists idx_bug_reports_created on public.bug_reports(created_at desc);
create index if not exists idx_bug_reports_status  on public.bug_reports(status) where status <> 'resolvido';
