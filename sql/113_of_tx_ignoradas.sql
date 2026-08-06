-- =====================================================================
-- 113 — Transações do Open Finance que o usuário APAGOU não podem voltar.
--
-- BUG QUE ISTO CORRIGE: o sync deduplica por `of_tx_id` consultando a tabela
-- `transacoes`. Se a linha foi APAGADA, ela não é encontrada — e o sync
-- seguinte reimporta a mesma transação como se fosse nova. Ou seja: hoje
-- excluir uma transação importada do banco não adianta, ela ressuscita.
--
-- Achado ao limpar uma duplicata real (Mercado Livre 5x, conta Nubank de um
-- cliente): a Polp mandou a MESMA compra parcelada em dois conjuntos de
-- transações, com ids diferentes e 1 centavo de diferença. Apagar as 4 linhas
-- duplicadas resolveria por um dia, até o próximo sync.
--
-- Vale pra qualquer exclusão de transação do Open Finance, não só duplicata:
-- é o usuário dizendo "não quero esta linha", e a Sora tem de respeitar.
-- =====================================================================

create table if not exists of_tx_ignoradas (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null,
  of_tx_id   text not null,
  motivo     text,
  created_at timestamptz not null default now()
);

-- A chave real: uma transação do provedor é ignorada UMA vez por grupo.
-- É por ela que o sync consulta, então precisa ser única e indexada.
create unique index if not exists of_tx_ignoradas_grupo_tx
  on of_tx_ignoradas (grupo_id, of_tx_id);

comment on table of_tx_ignoradas is
  'of_tx_id que o usuário apagou. O sync NÃO reimporta o que está aqui — sem isso, transação apagada do Open Finance volta no sync seguinte.';

-- Conferência:
--   select count(*) from of_tx_ignoradas;
