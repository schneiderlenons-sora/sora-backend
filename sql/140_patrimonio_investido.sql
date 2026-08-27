-- =====================================================================
-- 140 — separa o INVESTIDO do patrimônio total no histórico
--
-- O gráfico "Evolução · Patrimônio" vive na aba Investimentos, logo abaixo do
-- card "PATRIMÔNIO TOTAL R$ 2.642,80" — que soma SÓ investimentos. Mas o
-- snapshot gravava `investimentos + saldo das contas` no mesmo campo.
--
-- Ou seja: o número grande dizia uma coisa e a linha embaixo dele desenharia
-- outra, sem nada na tela explicando a diferença. É a mesma divergência de
-- definição que já custou caro na fatura do cartão — duas telas, dois números,
-- mesmo dia.
--
-- Agora `investido` guarda só a carteira de investimentos (é o que a aba
-- desenha) e `patrimonio_total` segue como estava, somando as contas, pra não
-- quebrar nada que já leia essa coluna.
--
-- ⚠️ NÃO DÁ PRA BACKFILL. As 90 linhas antigas guardam a SOMA e não há como
-- separar o investido do saldo em conta retroativamente — não existe registro
-- do saldo daquele dia. `investido` fica nulo nelas, e a tela ignora ponto sem
-- valor em vez de desenhar zero: um zero ali leria como "a carteira zerou".
--
-- Idempotente.
-- =====================================================================

alter table public.patrimonio_historico
  add column if not exists investido numeric;

comment on column public.patrimonio_historico.investido is
  'Só a carteira de investimentos (soma de investimentos.valor_atual). É o que a aba Investimentos desenha. `patrimonio_total` inclui também o saldo das contas.';

-- ── Conferência (rodar solto) ─────────────────────────────────────────
-- select date_trunc('day', data) as dia, count(*),
--        count(investido) as com_investido
--   from public.patrimonio_historico group by 1 order by 1 desc limit 10;
