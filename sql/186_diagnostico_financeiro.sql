-- =============================================================================
-- 186 — Retratos do DIAGNÓSTICO FINANCEIRO (services/diagnosticoFinanceiro.js)
--
-- A varredura roda todo dia às 04:30 (SP) e pelo botão do /admin. Cada rodada
-- grava um retrato aqui; o painel mostra o último e o que é NOVO em relação ao
-- anterior. É dado interno (só o admin lê, pelo backend com service role) —
-- nada de cliente é gravado ou alterado pela varredura.
--
-- Sem esta tabela a varredura funciona igual, só não guarda histórico.
-- Idempotente.
-- =============================================================================
create table if not exists diagnostico_financeiro (
  id         uuid primary key default gen_random_uuid(),
  gerado_em  timestamptz not null default now(),
  resumo     jsonb not null default '{}'::jsonb,   -- { erros, atencoes, sinais }
  relatorio  jsonb not null default '{}'::jsonb    -- checks + escopo
);

create index if not exists diagnostico_financeiro_gerado_em_idx
  on diagnostico_financeiro (gerado_em desc);

-- Só o service role acessa (o backend). Sem policy = ninguém mais lê.
alter table diagnostico_financeiro enable row level security;

-- Limpeza: guarda 90 dias de retratos (1 por dia ≈ 90 linhas).
delete from diagnostico_financeiro where gerado_em < now() - interval '90 days';
