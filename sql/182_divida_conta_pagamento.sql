-- =============================================================================
-- 182 — De qual CONTA sai a parcela da dívida.
--
-- Relato (vnsposito, out/2026), com três prints em sequência: no Extrato a
-- parcela do IPVA aparece como **"Sem conta · previsto"**; ele foi em Previstos
-- para vincular a conta, o lápis o levou ao modal "Editar dívida" — e lá não
-- existe campo de conta nenhum. Nas palavras dele: *"não consigo nunca vincular
-- uma dívida a uma Conta Bancária, furando assim minhas previsões por conta"*.
--
-- ⚠️ ELE ESTÁ CERTO, E ISSO JÁ ESTAVA REGISTRADO como limitação conhecida:
--     "DÍVIDA E FATURA NÃO ENTRAM na conta filtrada — e não por escolha daqui:
--      nenhuma das duas tem conta de débito (`dividas` não tem a coluna; a
--      fatura vem do cartão)."
-- A FATURA ganhou a dela na migration 170 (`wallets.conta_pagamento_id`). A
-- dívida ficou para trás — e é o que esta migration corrige.
--
-- ⚠️ POR ID, NUNCA PELO NOME. Mesma decisão da 170: renomear a conta não pode
-- desligar o vínculo. É também o que diferencia isto de `transacoes.carteira_nome`
-- (texto), que é a origem das contas-fantasma documentadas no CLAUDE.md.
--
-- ⚠️ `ON DELETE SET NULL`, nunca CASCADE: apagar a conta bancária não pode
-- levar junto a DÍVIDA da pessoa. Ela volta a ser "sem conta", que é
-- exatamente o estado de antes desta migration.
--
-- ⚠️ SEM ELA NADA QUEBRA: o motor do extrato já lê `d.carteira ?? null` (sempre
-- null até aqui) e a tela mostra "Sem conta". O `PUT /dividas/:id` lê o erro do
-- update, então quem tentar escolher a conta recebe a recusa explicada em vez
-- de a tela fechar dizendo que salvou — o defeito das migrations 121 e 147.
-- =============================================================================

alter table public.dividas
  add column if not exists conta_pagamento_id uuid
  references public.wallets(id) on delete set null;

comment on column public.dividas.conta_pagamento_id is
  'Conta de DÉBITO de onde sai a parcela desta dívida. Põe a parcela no Extrato Futuro daquela conta (sem ela, a parcela só aparece em "Todas as contas"). Por ID: renomear a conta não desliga o vínculo. NULL = sem conta definida.';

-- Acelera o "quais dívidas saem desta conta" do extrato filtrado.
create index if not exists idx_dividas_conta_pagamento
  on public.dividas (conta_pagamento_id)
  where conta_pagamento_id is not null;

-- Conferência:
--   select titulo, conta_pagamento_id from dividas where conta_pagamento_id is not null;
