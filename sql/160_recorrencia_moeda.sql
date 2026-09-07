-- =============================================================================
-- 160 — conta fixa (recorrência) em moeda estrangeira.
--
-- Relato: "tentei fazer uma despesa/receita fixa mensal em NOK, mas essas
-- continuam em R$. É porque eu recebo meu salário em NOK."
--
-- `transacoes` já tinha estes três campos (migration 144) e `recorrencias` não,
-- então o salário dele entrou como R$ 20.000 onde ele quis dizer kr 20.000
-- (≈ R$ 11.000). Isto ESPELHA a transação, campo a campo, de propósito: mesma
-- forma, mesma regra, mesmo modelo mental.
--
-- ⚠️ `valor` CONTINUA SENDO BRL, e é isso que torna a mudança segura. 22
-- arquivos entre painel e backend somam `recorrencias.valor` (projeção dos
-- Previstos, saldo projetado, agenda, Oráculo, resumo do WhatsApp…). Converter
-- na LEITURA obrigaria os 22 a conhecer moeda e cotação — a receita exata das
-- "5 cópias divergentes da mesma regra" que este projeto já pagou caro. Aqui
-- ninguém precisa mudar: quem lê `valor` continua lendo real.
--
-- ⚠️ E POR ISSO O BRL PRECISA SER REFRESCADO. Um salário de kr 20.000 vale um
-- real diferente a cada mês; congelar a conversão na criação deixaria a
-- projeção errada e envelhecendo. Quem atualiza é o JOB 1M (o mesmo que aquece
-- as cotações, todo dia às 05:00), num lugar só.
--
-- ⚠️ O BACKFILL ABAIXO REINTERPRETA as recorrências que já existem em carteira
-- estrangeira: `valor_moeda = valor`, porque o número que a pessoa digitou É o
-- nativo — ela digitou 20000 querendo dizer coroas. NÃO calcula o BRL aqui: sem
-- cotação dentro do SQL, sairia um número inventado ou desatualizado. `valor`
-- fica como está até o JOB 1M rodar (ou o app converter), e aí vira o correto.
-- Medido em 06/09/2026: 3 linhas em toda a base, todas do mesmo cliente.
-- =============================================================================

alter table public.recorrencias add column if not exists moeda       text;
alter table public.recorrencias add column if not exists valor_moeda numeric(14, 2);
alter table public.recorrencias add column if not exists taxa_brl    numeric(18, 8);

comment on column public.recorrencias.moeda is
  'Moeda em que o valor foi informado (null = BRL). Espelha transacoes.moeda.';
comment on column public.recorrencias.valor_moeda is
  'Valor NATIVO, na moeda acima. `valor` segue sendo o equivalente em BRL.';
comment on column public.recorrencias.taxa_brl is
  'Cotação usada no último cálculo de `valor`. Atualizada pelo JOB 1M.';

-- ── Backfill: o que já existe em carteira estrangeira era nativo o tempo todo ─
update public.recorrencias r
   set moeda       = w.moeda,
       valor_moeda = r.valor
  from public.wallets w
 where w.grupo_id = r.grupo_id
   and lower(btrim(w.nome)) = lower(btrim(r.carteira))
   and coalesce(w.moeda, 'BRL') <> 'BRL'
   and r.moeda is null;
