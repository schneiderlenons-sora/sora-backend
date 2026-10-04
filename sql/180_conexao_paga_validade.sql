-- =============================================================================
-- 180 — Até quando a conexão avulsa PAGA vale.
--
-- Caso que deu origem (04/10/2026), medido no Stripe: `gilbertojun@gmail.com`
-- pagou **R$ 60,00 com sucesso em 17/08/2026** por uma conexão de Open Finance
-- ANUAL, e **não houve reembolso** (conferido em todas as cobranças e faturas
-- do customer). Depois ele tentou subir para 2 conexões, a cobrança da
-- diferença (R$ 59,99) falhou cerca de 40 vezes, e o Stripe cancelou a
-- assinatura em 01/09 — levando junto `of_conexoes_pagas` para 0 pelo webhook
-- `customer.subscription.deleted`.
--
-- Resultado: ele ficou com DUAS conexões ativas e ZERO direito registrado,
-- prestes a perder as duas no corte do JOB 1R — inclusive a que ele pagou e
-- que vale até **17/08/2027**.
--
-- ⚠️ POR QUE UMA COLUNA, E NÃO SÓ `of_conexoes_pagas = 1`:
-- sem validade, um ano pago vira conexão grátis **para sempre**. É exatamente o
-- buraco que originou este projeto inteiro ("a franquia só era checada ao
-- CONECTAR; depois nada reavaliava"). Repetir isso em cima da correção seria
-- trocar um vazamento por outro, só que mais difícil de achar depois.
--
-- ⚠️ NULL = SEM PRAZO, e é o que a base inteira tem hoje. Assinatura mensal
-- viva não precisa de data: quem responde por ela é o webhook do Stripe, que
-- zera `of_conexoes_pagas` quando a assinatura morre. A data existe para o caso
-- em que **não haverá evento futuro nenhum** — pagamento anual cuja assinatura
-- já foi cancelada.
--
-- ⚠️ SEM ELA NADA QUEBRA: `acessoOpenFinance` lê a coluna numa tentativa
-- própria e, se ela não existir, REFAZ a leitura sem ela. Essa segunda tentativa
-- é obrigatória — um `select` que erra devolve `data: null`, e tratar isso como
-- "pagas = 0" tiraria o Open Finance de TODO cliente que paga conexão, no
-- intervalo entre o deploy e esta migration rodar.
-- =============================================================================

alter table public.users
  add column if not exists of_conexoes_pagas_ate timestamptz;

comment on column public.users.of_conexoes_pagas_ate is
  'Até quando as conexões de `of_conexoes_pagas` valem. NULL = sem prazo (assinatura viva, quem encerra é o webhook do Stripe). Usado quando o cliente pagou um período que não terá evento futuro — ex.: anual cuja assinatura já foi cancelada.';

-- ── O caso do gilbertojun ────────────────────────────────────────────────────
-- `of_conexoes_pagas = 1` já foi lançado à mão em 04/10/2026 (para que o corte
-- de 06/10 não levasse a conexão paga junto). Aqui entra só a DATA, que é o que
-- impede isso de virar cortesia vitalícia.
--
-- Idempotente e ESTREITO: só grava se a linha ainda estiver em 1 conexão paga e
-- sem prazo. Se alguém reassinar no Stripe, o webhook reescreve `of_conexoes_pagas`
-- e esta migration não deve atropelar o valor novo.
update public.users
   set of_conexoes_pagas     = 1,
       of_conexoes_pagas_ate = timestamptz '2027-08-17 00:00:00-03'
 where email = 'gilbertojun@gmail.com'
   and coalesce(of_conexoes_pagas, 0) <= 1
   and of_conexoes_pagas_ate is null;

-- Conferência:
--   select email, of_conexoes_pagas, of_conexoes_pagas_ate
--     from users where of_conexoes_pagas_ate is not null;
