-- =============================================================================
-- 165 — A OCORRÊNCIA: o elo que faltava entre a REGRA e o FATO.
--
-- POR QUE EXISTE. Relato de cliente, palavra por palavra:
--
--   "Tenho um gasto fixo de ~R$ 1.700 com plano de saúde. Se eu antecipo o
--    pagamento, não consigo dar baixa naquele valor previsto do mês. Se
--    registro o pagamento como nova transação, passo a ter valores duplicados,
--    afetando a leitura do saldo."
--
-- Ele está descrevendo um buraco estrutural. A Sora tem DUAS camadas:
--
--   REGRA   `recorrencias`  — "R$ 1.700 todo dia 10"
--   FATO    `transacoes`    — "paguei R$ 1.700 no dia 8"
--
-- E nada entre elas. Não existe a OCORRÊNCIA: a instância datada daquele
-- compromisso, que pode ser adiantada, atrasada, ter valor diferente, ser
-- pulada ou quitada — individualmente, SEM mexer na regra.
--
-- Sem esse elo, o fato não sabe que cumpriu a regra: a projeção continua
-- contando a previsão E a transação. Daí a duplicata que ele relatou.
--
-- ⚠️ O PRÓPRIO CÓDIGO JÁ LAMENTAVA ISSO. Em `services/saldo-projetado` (porte
-- em `lib/saldo-projetado.ts`) está escrito:
--
--   "exigiria casar cada [Previsto] com a sua recorrência — e NÃO EXISTE
--    recorrencia_id em transacoes (conferido no schema), então o casamento
--    seria por descrição, que é justamente o tipo de palpite que já causou bug
--    nesta base."
--
-- Esta migration cria o vínculo que faltava. O casamento deixa de ser por texto.
--
-- ⚠️ A CHAVE É A COMPETÊNCIA, NÃO A DATA. É o que faz "paguei dia 8 a conta que
-- vence dia 10" ser reconhecido como quitação de SETEMBRO: a data difere, a
-- competência não. Mesma ideia do `competenciaDoPagamento` que resolveu o
-- pagamento de fatura do cartão.
--
-- ⚠️ TOTALMENTE ADITIVA E INERTE. Só cria coluna e tabela novas. Nenhum código
-- em produção lê ou escreve nada disto até o merge — rodar esta migration com o
-- master no ar não muda NADA de comportamento.
-- =============================================================================

-- ── 1. Qual ocorrência esta transação quitou ────────────────────────────────
--
-- ⚠️ `on delete set null`, NUNCA cascade. Apagar a conta fixa não pode apagar o
-- histórico de pagamentos — o dinheiro saiu da conta de verdade, e a transação
-- tem de sobreviver à regra que a originou.
alter table public.transacoes
  add column if not exists recorrencia_id uuid references public.recorrencias(id) on delete set null,
  add column if not exists competencia    text;

comment on column public.transacoes.recorrencia_id is
  'Qual conta fixa esta transacao quitou. NULL = transacao avulsa (o caso comum).';
comment on column public.transacoes.competencia is
  'Competencia YYYY-MM da ocorrencia quitada. Difere da data quando o pagamento foi adiantado ou atrasado.';

-- A pergunta quente é "esta ocorrência já foi quitada?" — grupo + regra + mês.
create index if not exists transacoes_ocorrencia_idx
  on public.transacoes (grupo_id, recorrencia_id, competencia)
  where recorrencia_id is not null;

-- ── 2. Ocorrências que fogem da regra SEM virar transação ───────────────────
--
-- Pular um mês ("este mês não vou pagar") e adiar ("caiu pro dia 20") não geram
-- transação nenhuma — são desvios da previsão. Guardar isso como transação de
-- valor zero sujaria o extrato e o resumo.
--
-- ⚠️ AQUI O CASCATA É O CERTO, ao contrário de cima: um ajuste de uma regra que
-- não existe mais não significa nada.
create table if not exists public.previsao_ajustes (
  id             uuid primary key default gen_random_uuid(),
  grupo_id       uuid not null,
  recorrencia_id uuid not null references public.recorrencias(id) on delete cascade,
  competencia    text not null,
  status         text not null check (status in ('pulado', 'movido')),
  nova_data      date,
  novo_valor     numeric(14, 2),
  criado_em      timestamptz not null default now(),
  -- Uma ocorrência tem no máximo UM ajuste. Reajustar sobrescreve.
  unique (recorrencia_id, competencia)
);

create index if not exists previsao_ajustes_grupo_idx
  on public.previsao_ajustes (grupo_id, competencia);

comment on table public.previsao_ajustes is
  'Desvios de UMA ocorrencia (pular, adiar) sem tocar na regra da recorrencia.';

-- ── 3. Baixa automática pelo Open Finance (chave GLOBAL, opt-in) ────────────
--
-- ⚠️ NASCE DESLIGADA de propósito. Ligada, a Sora quita a previsão sozinha
-- quando o banco confirma a cobrança; desligada (padrão), ela apenas SUGERE e
-- a pessoa confirma com um toque.
--
-- ⚠️ O casamento NÃO usa o nome. Ele usa carteira + valor + janela de data —
-- e isso não é escolha de estilo, é lição medida: `parcelasPrevistas.js`
-- registra que a Polp manda a mesma compra com descrições diferentes, e que
-- casar por descrição devolvia ZERO. Por isso o aviso na tela fala de "valor
-- parecido na mesma semana", não de nome igual ao do banco.
--
-- ⚠️ Mesmo LIGADA, ela nunca quita quando há mais de uma previsão candidata,
-- nem em conta de valor variável (onde o valor — o sinal forte — não existe).
alter table public.users
  add column if not exists baixa_automatica boolean not null default false;

comment on column public.users.baixa_automatica is
  'Open Finance quita a previsao sozinho. false (padrao) = apenas sugere.';
