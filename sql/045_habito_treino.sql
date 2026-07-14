-- 045: Vincula hábito ↔ treino (sync de mão dupla)
-- Permite criar um treino "como hábito": checar o hábito (aba Hábitos ou
-- dashboard) cria a sessão de treino do dia; registrar uma sessão detalhada
-- marca o hábito. Idempotente.

-- Hábito aponta pro treino que ele acompanha + duração padrão do check rápido.
alter table public.habitos
  add column if not exists treino_id uuid references public.treinos(id) on delete set null,
  add column if not exists treino_duracao_padrao int;

-- Marca a origem da sessão: 'manual' (digitada no Treinos) ou 'habito'
-- (auto-criada ao checar o hábito). Desmarcar o hábito só remove as 'habito'.
alter table public.treino_registros
  add column if not exists origem text not null default 'manual'
    check (origem in ('manual','habito'));

-- Sync rápido: achar a sessão de um treino num dia/usuário (e a origem).
create index if not exists idx_treino_reg_sync
  on public.treino_registros (user_id, treino_id, data, origem);

-- Sync rápido: achar o hábito vinculado a um treino.
create index if not exists idx_habitos_treino
  on public.habitos (treino_id) where treino_id is not null;
