-- =====================================================================
-- 137 — `investimentos.tipo` aceita os papéis que os bancos realmente vendem
--
-- MOTIVO: 'CDB' vinha carregando CDB, RDB, LCI, LCA e LC de uma vez. São
-- produtos diferentes, com tributação e garantia diferentes — e o RDB em
-- especial é o que os bancos digitais mais usam: TODA caixinha do Nubank é um
-- RDB. Enquanto tudo virava "CDB", a carteira não tinha como mostrar o que a
-- pessoa de fato tem.
--
-- Medido numa conta real: 22 posições, todas gravadas como 'CDB', todas com o
-- nome "RDB" vindo do banco. O dado certo já chegava; faltava onde guardá-lo.
--
-- ⚠️ MESMA FAMÍLIA DO `users_plano_check` E DA 121: valor novo na aplicação
-- precisa entrar no CHECK, senão a gravação falha CALADA. A lista abaixo
-- espelha TIPOS em `components/investimentos/NovoInvestimentoModal.tsx` e o
-- que `tipoInvestimento()` produz no sync. Mexeu num, mexa nos outros.
--
-- ⚠️ Nenhum tipo foi REMOVIDO: tirar um da lista quebraria as linhas que já o
-- usam, e o `alter table` falharia inteiro por causa delas.
--
-- Idempotente.
-- =====================================================================

alter table public.investimentos
  drop constraint if exists investimentos_tipo_check;

alter table public.investimentos
  add constraint investimentos_tipo_check check (tipo in (
    -- Renda variável
    'Ações',
    'FIIs',
    'ETFs',
    'Cripto',
    -- Renda fixa pública
    'Tesouro Direto',
    -- Renda fixa bancária · OF: bank_fixed_income
    'CDB',
    'RDB',              -- NOVO — recibo de depósito (caixinhas dos digitais)
    'LCI',              -- NOVO — letra de crédito imobiliário
    'LCA',              -- NOVO — letra de crédito do agronegócio
    'LC',               -- NOVO — letra de câmbio
    'Poupança',         -- NOVO
    -- Renda fixa de crédito privado · OF: credit_fixed_income
    'Debênture',        -- NOVO
    'CRI',              -- NOVO
    'CRA',              -- NOVO
    'COE',              -- NOVO — certificado de operações estruturadas
    'Renda Fixa',       -- guarda-chuva pro que não se encaixa acima
    -- Fundos
    'Fundos',
    'Previdência',
    -- Caixa e outros
    'Reserva',
    'Imóveis',
    'Negócio',
    'Caixa'
  ));

-- ── Reclassifica o que o banco já tinha dito ser RDB ──────────────────
-- O sync gravava tipo='CDB' com nome='RDB' porque não havia opção melhor.
-- Agora que existe, o histórico passa a refletir o produto de verdade.
update public.investimentos
   set tipo = 'RDB'
 where tipo = 'CDB'
   and upper(btrim(coalesce(nome, ''))) = 'RDB';

-- ── Conferência (rodar solto) ─────────────────────────────────────────
-- select tipo, count(*), sum(valor_atual) from public.investimentos
--  group by tipo order by 2 desc;
