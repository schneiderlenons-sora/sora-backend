-- 190 — Pagamento de dívida LIGADO ao débito do extrato.
--
-- Relato (Robert, out/2026): o extrato do Banco do Brasil trazia o débito do
-- empréstimo, mas nada ligava esse débito à dívida, e a parcela seguia "não
-- paga". Agora o "Pagar parcela" (e a sugestão "Já saiu do banco") registra o
-- pagamento apontando pra transação que o pagou, SEM debitar a conta de novo.
--
-- A coluna guarda esse vínculo. Serve pra:
--   · não sugerir o MESMO débito pra outra parcela;
--   · a tela dizer "pago com o débito de 20/10 do Banco do Brasil".
--
-- ⚠️ SEM unique em transacao_id, de propósito: um débito único pode pagar
-- VÁRIAS dívidas (a Cooperforte debita R$ 1.000,08 que cobre três empréstimos).
-- O que não pode é o mesmo débito na MESMA dívida duas vezes — isso o servidor
-- confere antes de gravar.
--
-- Sem esta migration: o pagamento é registrado do mesmo jeito (sem o vínculo)
-- e a sugestão continua funcionando; só perde a trava de "débito já usado".
-- Idempotente.

alter table public.divida_pagamentos
  add column if not exists transacao_id uuid references public.transacoes(id) on delete set null;

create index if not exists divida_pagamentos_transacao_idx
  on public.divida_pagamentos (transacao_id)
  where transacao_id is not null;
