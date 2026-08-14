-- =============================================================================
-- 121 — CHECK de `investimentos.tipo` aceita TODOS os tipos que o painel oferece
--
-- RELATO REAL (cliente premium): "tentei incluir valores nos investimentos,
-- porém não está salvando e atualizando". Patrimônio R$ 0,00 com a conta
-- funcionando normalmente (626 transações, 2 conexões de Open Finance ativas).
--
-- CAUSA: a constraint `investimentos_tipo_check` rejeitava 5 dos 13 tipos que o
-- modal "Novo investimento" oferece. MEDIDO, tentando inserir um de cada:
--     ✅ Ações · FIIs · ETFs · Cripto · Tesouro Direto · Previdência
--        · Imóveis · Caixa
--     ❌ CDB · Renda Fixa · Fundos · Reserva · Negócio
--
-- Prova de que nunca funcionou: na base inteira só existem 5 tipos distintos
-- (FIIs 22, Ações 6, Tesouro 3, Cripto 3, Caixa 2) — nenhum dos 5 barrados,
-- em 36 investimentos.
--
-- ⚠️ MESMA LIÇÃO do `users_plano_check` (memória `project-plano-check-constraint`):
-- valor novo na aplicação precisa entrar no CHECK, senão a gravação falha
-- CALADA. Aqui foi pior porque a rota engolia o erro (corrigido junto, em
-- `routes/investimentos.js`).
--
-- ⚠️ ISSO TAMBÉM DESTRAVA O OPEN FINANCE: `tipoInvestimento` em
-- `polpCelcoinSync.js` classifica renda fixa bancária como **CDB**, crédito
-- privado como **Renda Fixa** e fundos como **Fundos** — os três barrados. Era
-- por isso que só renda variável (FIIs/Ações) aparecia na base: não era
-- ausência de dado do banco, era a constraint recusando o insert.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

alter table public.investimentos
  drop constraint if exists investimentos_tipo_check;

-- A lista espelha TIPOS em components/investimentos/NovoInvestimentoModal.tsx
-- e os tipos que o sync do Open Finance produz. Mexeu num, mexa no outro.
alter table public.investimentos
  add constraint investimentos_tipo_check check (tipo in (
    'Ações',
    'FIIs',
    'ETFs',
    'Cripto',
    'Tesouro Direto',
    'CDB',              -- CDB/CDI/LCI/LCA  · OF: bank_fixed_income
    'Renda Fixa',       -- Debêntures/CRI/CRA · OF: credit_fixed_income
    'Fundos',           -- Fundos de investimento · OF: fund
    'Previdência',
    'Reserva',          -- liquidez diária (reserva de emergência)
    'Imóveis',
    'Negócio',
    'Caixa'
  ));

-- =============================================================================
-- Verificação (deve inserir e apagar sem erro):
--   insert into public.investimentos (grupo_id, tipo, nome, valor_aportado, valor_atual)
--     select grupo_id, 'CDB', '__teste__', 1, 1 from public.investimentos limit 1;
--   delete from public.investimentos where nome = '__teste__';
-- =============================================================================
