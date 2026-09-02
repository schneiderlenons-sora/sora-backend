-- =============================================================================
-- 147 — Atrelar investimento a uma meta
--
-- Pedido de cliente: "seria interessante atrelar o investimento à meta".
--
-- ⚠️ O VÍNCULO MORA EM `investimentos`, NÃO EM `metas`.
-- Com `metas.investimento_id` uma meta só poderia ser lastreada por UM
-- investimento, e o mesmo investimento poderia ser apontado por várias metas —
-- que é exatamente como nasce contagem dupla. Deste lado, N investimentos
-- apontam pra 1 meta e cada investimento pertence a no máximo uma.
--
-- ⚠️ `ON DELETE SET NULL`, nunca CASCADE: apagar uma meta não pode levar junto
-- o investimento do usuário. Ele só perde o vínculo.
--
-- ⚠️ O PROGRESSO DA META CONTINUA SENDO CALCULADO NA LEITURA.
-- `metas.valor_atual` é coluna alimentada por aporte/resgate; gravar a soma dos
-- investimentos ali faria o número ficar inflado PARA SEMPRE assim que alguém
-- desvinculasse. A rota soma na hora e devolve a composição separada.
--
-- Nota: existe um `POST /api/investimentos/metas` legado que já tentava gravar
-- `investimento_id` — junto de `nome`, `prazo_anos`, `taxa_anual` e
-- `aporte_mensal_sugerido`, nenhuma das quais existe. Ele nunca funcionou e
-- respondia 200 com null por não ler o `error`. Esta migration NÃO ressuscita
-- aquele desenho: as metas de verdade são as de `routes/metas.js`.
-- =============================================================================

alter table investimentos
  add column if not exists meta_id uuid references metas(id) on delete set null;

comment on column investimentos.meta_id is
  'Meta que este investimento lastreia (migration 147). NULL = não atrelado. O progresso da meta soma isto na LEITURA — nunca gravar em metas.valor_atual.';

-- Só as linhas atreladas entram no índice: a esmagadora maioria é NULL.
create index if not exists idx_investimentos_meta_id
  on investimentos (meta_id)
  where meta_id is not null;
