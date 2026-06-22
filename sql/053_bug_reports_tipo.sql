-- 053: tipo em bug_reports — separa "problema" (bug) de "melhoria" (sugestao).
-- A aba "Relatar um problema" agora tem tambem "Propor uma melhoria"; as
-- melhorias aparecem num card proprio no admin. Linhas antigas viram 'problema'
-- (default). Idempotente.

alter table public.bug_reports
  add column if not exists tipo text not null default 'problema'
  check (tipo in ('problema','melhoria'));

create index if not exists idx_bug_reports_tipo on public.bug_reports(tipo);
