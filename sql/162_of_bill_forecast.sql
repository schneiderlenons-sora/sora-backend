-- =============================================================================
-- 162 — `transacoes.of_bill_forecast`: o MÊS DE FATURAMENTO informado pelo
-- próprio emissor (`bill_forecast_date`, formato AAAA-MM).
--
-- ⚠️ ESTA MIGRATION É SÓ COLETA. Nenhum cálculo lê esta coluna ainda, de
-- propósito — o valor exibido em nenhuma tela muda ao rodá-la. Ela existe pra
-- que, com histórico na mão, dê pra MEDIR o campo do emissor contra a nossa
-- reconstrução antes de trocar uma pela outra. Trocar às cegas seria repetir o
-- erro que já custou caro aqui.
--
-- POR QUE ELA IMPORTA. Hoje a Sora reconstrói na mão a qual fatura cada compra
-- pertence, cruzando `cicloFatura` + `bill_post_date` + heurísticas de borda. É
-- reconstrução, e ela erra justamente na virada do ciclo: relato de set/2026 —
-- app do banco R$ 472,66, painel R$ 4.091,58, porque duas compras do DIA DO
-- FECHAMENTO (iFood 41,14 e Apple 5,00) foram faturadas pelo banco no mês
-- seguinte e a Sora as manteve no mês que fechou.
--
-- O `bill_forecast_date` responde isso direto, sem heurística: a doc da Celcoin
-- diz que ele é "sempre preenchido, inclusive para parcelas futuras e
-- lançamentos agendados". Se ele se confirmar fiel na medição, vira a fonte
-- primária e várias regras de borda deixam de ser necessárias.
--
-- ⚠️ NÃO CONFUNDIR COM `bill_post_date` (migration 130), que é a DATA em que o
-- emissor lançou a compra. São coisas diferentes: o post_date vem VAZIO
-- enquanto a compra não foi faturada — e é essa lacuna que o forecast preenche.
--
-- Segura de rodar a qualquer momento: coluna nova, anulável, sem default e sem
-- índice. O sync já sabe conviver com ela ausente (COLUNAS_OPCIONAIS).
-- =============================================================================

alter table public.transacoes add column if not exists of_bill_forecast text;

comment on column public.transacoes.of_bill_forecast is
  'Mês de faturamento informado pelo emissor (bill_forecast_date), AAAA-MM. SÓ COLETA — nenhum cálculo lê esta coluna ainda; ver migration 162.';
