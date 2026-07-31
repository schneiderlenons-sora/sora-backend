-- =====================================================================
-- 109 — Comissão de vendedor e custo real da equipe (fase 5)
--
-- Duas coisas que faltavam pra a folha dizer a verdade:
--
-- 1. COMISSÃO. Em loja e prestador de serviço, boa parte do que se paga à
--    equipe é comissão, não salário. Sem registrar, a folha parece menor do
--    que é e a margem por venda parece maior.
--
--    A comissão fica CONGELADA na venda (`comissao_valor`), pelo mesmo motivo
--    que preço e custo congelam: mudar o percentual do vendedor amanhã não
--    pode reescrever quanto ele ganhou ontem.
--
-- 2. ENCARGOS (opt-in). Salário não é o custo do funcionário: FGTS, 13º e
--    férias somam perto de 30% em cima. Fica DESLIGADO por padrão porque
--    depende do regime — no Simples Nacional (anexos I a III) a contribuição
--    patronal já vai dentro do DAS, e somar de novo inventaria uma despesa.
--    Quem liga vê o aviso de conferir com o contador.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.funcionarios_negocio
  -- % sobre o total da venda em que a pessoa é a vendedora.
  add column if not exists comissao_pct numeric(5,2) not null default 0,
  -- Estimar encargos no custo desta pessoa (só faz sentido em CLT).
  add column if not exists encargos boolean not null default false;

alter table public.vendas_negocio
  -- Congelada no momento da venda (o pct do vendedor pode mudar depois).
  add column if not exists comissao_valor integer not null default 0,
  -- Nulo = comissão ainda devida. Marcar aqui é o que impede pagar duas vezes.
  add column if not exists comissao_paga_em date;

-- "Quais comissões ainda devo?" é a query da tela de equipe.
create index if not exists idx_vendas_comissao_aberta
  on public.vendas_negocio(empresa_id, vendedor_id)
  where comissao_valor > 0 and comissao_paga_em is null;
