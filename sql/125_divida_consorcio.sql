-- =============================================================================
-- 125 — Tipo CONSÓRCIO em Dívidas, com as particularidades dele
--
-- PEDIDO DE USUÁRIO: "onde posso colocar e controlar as cartas de consórcio?"
--
-- Hoje ele cadastra como "Financiamento", que cobre a parte de PAGAR (parcelas,
-- vencimento, progresso) mas ignora o que faz o consórcio ser diferente:
--
--   · CARTA DE CRÉDITO — quanto ele VAI RECEBER. É um ativo, não só dívida.
--     Financiamento não tem isso: você já recebeu o bem lá atrás.
--   · CONTEMPLAÇÃO — antes dela você paga sem ter nada; depois, você tem o
--     crédito. É o divisor de águas do consórcio, e não existe em nenhum
--     outro tipo de dívida.
--   · LANCE — valor ofertado pra antecipar a contemplação.
--   · GRUPO/COTA — como a administradora identifica a carta.
--
-- ⚠️ MESMA FAMÍLIA do `investimentos_tipo_check` (migration 121) e do
-- `users_plano_check`: o CHECK de `tipo` recusava 'consorcio' e a gravação
-- falharia. MEDIDO antes de escrever: inserir tipo='consorcio' devolve
-- "violates check constraint dividas_tipo_check". A lista abaixo inclui TODOS
-- os tipos já em uso na base (parcelamento, emprestimo, outro, cartao_rotativo,
-- financiamento, crediario, cheque_especial) mais os do painel (consignado,
-- fies) — recriar sem algum deles quebraria dívida existente.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

alter table public.dividas drop constraint if exists dividas_tipo_check;
alter table public.dividas add constraint dividas_tipo_check check (tipo in (
  'emprestimo',
  'financiamento',
  'consorcio',        -- ← NOVO
  'crediario',
  'cartao_rotativo',
  'cheque_especial',
  'consignado',
  'fies',
  'parcelamento',     -- compra parcelada sem cartão
  'outro'
));

-- ── Campos só do consórcio ──────────────────────────────────────────────────
-- Prefixo `consorcio_` de propósito: deixa explícito que só valem pra esse
-- tipo e evita confundir com os campos gerais de dívida.

-- Valor da CARTA — o crédito que ele vai receber (ou já recebeu).
alter table public.dividas add column if not exists consorcio_credito numeric(14,2);

-- Contemplado? Antes: paga e espera. Depois: tem o crédito em mãos.
alter table public.dividas add column if not exists consorcio_contemplado boolean not null default false;
alter table public.dividas add column if not exists consorcio_contemplado_em date;

-- Lance ofertado pra antecipar a contemplação (0/null = não deu lance).
alter table public.dividas add column if not exists consorcio_lance numeric(14,2);

-- Identificação na administradora — "grupo 1234 · cota 56".
alter table public.dividas add column if not exists consorcio_grupo text;
alter table public.dividas add column if not exists consorcio_cota  text;

-- ⚠️ A taxa de administração NÃO ganha coluna: `taxa_juros` já existe e é uma
-- taxa em % — usar as duas seria ter duas fontes pro mesmo número. O rótulo na
-- tela muda pra "Taxa de administração" quando o tipo é consórcio.

-- =============================================================================
-- Verificação:
--   select titulo, tipo, consorcio_credito, consorcio_contemplado
--     from public.dividas where tipo = 'consorcio';
-- =============================================================================
