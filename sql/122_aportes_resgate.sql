-- =============================================================================
-- 122 — Resgate de investimento (`aportes.tipo`)
--
-- RELATO DE USUÁRIO: "não achei a opção de resgate de investimentos na
-- plataforma, e nem de aporte".
--
-- Ele estava certo nos DOIS pontos:
--   · APORTE  — existia por WhatsApp e a rota `POST /api/investimentos/aportes`
--               também, mas o painel só LISTAVA (a aba "Aportes" não tinha
--               nenhum botão de criar). O texto do estado vazio ainda dizia
--               "pelo WhatsApp ou pelo painel", o que induzia ao erro.
--   · RESGATE — não existia em lugar nenhum: nem rota, nem WhatsApp, nem
--               painel. Só METAS tinham resgate (`meta_aportes.tipo`).
--
-- Esta migration espelha o que `meta_aportes` já faz desde a 008: uma coluna
-- `tipo` separando entrada de saída, no MESMO extrato. Assim o histórico de um
-- investimento conta a história inteira (aportou, aportou, resgatou), em vez de
-- exigir uma tabela paralela só pra saída.
--
-- `default 'aporte'` mantém as linhas existentes válidas sem backfill.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

alter table public.aportes add column if not exists tipo text not null default 'aporte';

-- Espelha o CHECK de `meta_aportes` (migration 008).
-- ⚠️ Lição das migrations 121 e do `users_plano_check`: valor novo na aplicação
-- precisa entrar no CHECK, senão a gravação falha CALADA.
alter table public.aportes drop constraint if exists aportes_tipo_check;
alter table public.aportes add constraint aportes_tipo_check check (tipo in ('aporte', 'resgate'));

-- Observação do resgate ("vendi metade pra pagar o carro") — `descricao` já
-- existe e é reusada; nada a criar.

create index if not exists idx_aportes_investimento on public.aportes(investimento_id, data desc);

-- =============================================================================
-- Verificação:
--   select tipo, count(*) from public.aportes group by tipo;
-- =============================================================================
