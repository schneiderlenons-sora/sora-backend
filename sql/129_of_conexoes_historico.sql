-- =============================================================================
-- 129 — `of_conexoes_historico`: guardar as desconexões
--
-- ⚠️ SEM ISTO NÃO DÁ PRA CONFERIR A FATURA DA POLP. Ela cobra por consentimento
-- "sincronizado/ativo NO CICLO" (R$ 3,60 cada). O painel deles marcou 35
-- enquanto a API `GET /consents` devolvia 25 e a Sora tinha 24 conexões — e a
-- hipótese mais provável pros 10 a mais é justamente consentimento que esteve
-- ativo durante o mês e foi revogado depois.
--
-- Não deu pra confirmar porque a desconexão APAGAVA a linha:
--   `await supabase.from('of_conexoes').delete().eq('id', c.id)`
-- Depois disso, nem nós nem a API deles sabem que aquele consentimento existiu.
-- Um mês de operação sem rastro de desconexão nenhuma.
--
-- ── POR QUE UMA TABELA À PARTE, E NÃO UM `desconectado_em` ──────────────────
-- Soft delete obrigaria TODO leitor de `of_conexoes` a filtrar a coluna nova —
-- e são muitos (sync, webhook, painel, admin, provider). Um esquecido e o sync
-- tentaria sincronizar banco desconectado, ou o admin contaria conexão morta.
-- Tabela separada não muda o comportamento de nenhuma leitura existente.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

create table if not exists public.of_conexoes_historico (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null,
  user_id       uuid,
  provider      text not null,
  external_id   text not null,
  instituicao   text,
  -- Status que a conexão tinha no momento em que saiu.
  status_final  text,
  -- Quando ela foi criada (copiado da linha original) — é o que dá a JANELA em
  -- que ela esteve viva, e portanto em quais ciclos de cobrança ela entrou.
  criada_em     timestamptz,
  desconectada_em timestamptz not null default now(),
  -- 'usuario' = clicou em desconectar. Espaço pra outros motivos depois
  -- (expiração automática, troca de banco, limpeza administrativa).
  motivo        text not null default 'usuario'
);

-- A pergunta que esta tabela existe pra responder é "o que saiu no período X",
-- então o índice é por data. `external_id` ajuda a cruzar com a lista da Polp.
create index if not exists idx_of_hist_desconectada on public.of_conexoes_historico(desconectada_em desc);
create index if not exists idx_of_hist_external on public.of_conexoes_historico(external_id);
create index if not exists idx_of_hist_grupo on public.of_conexoes_historico(grupo_id);

-- =============================================================================
-- Verificação (depois de alguma desconexão):
--   select instituicao, status_final, criada_em, desconectada_em, motivo
--     from public.of_conexoes_historico
--    order by desconectada_em desc;
--
-- Pra bater com a fatura de um ciclo — quantas estiveram vivas nele:
--   select count(*) from public.of_conexoes_historico
--    where desconectada_em >= '2026-09-01' and criada_em < '2026-10-01';
-- =============================================================================
