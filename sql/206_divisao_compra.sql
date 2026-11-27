-- 206 — Compra do cartão DIVIDIDA com outra pessoa (pedido do Arisson, nov/2026).
--
-- "Comprei uma geladeira de R$ 3.000 em 10x de R$ 300 e minha esposa paga
-- metade": cada parcela guarda COM QUEM foi dividida e QUANTO é da outra
-- pessoa naquela linha. A compra continua inteira (é o que o banco cobra na
-- fatura); a parte da outra pessoa é o que ela deve.
--
-- `divisoes_acertos` = o que a outra pessoa já acertou de uma fatura:
--   · 'conta'    → mandou o dinheiro pra uma conta manual (a Sora lança a
--                   entrada como reembolso, fora das receitas);
--   · 'vincular' → o Pix dela já está no extrato (banco ou manual): a linha é
--                   marcada como reembolso, fora das receitas;
--   · 'fatura'   → pagou a parte dela direto na fatura ("pago por fora" do
--                   Pagar fatura);
--   · 'registro' → acertou de outro jeito (dinheiro em mão etc.).
-- `transacao_id` com ON DELETE CASCADE: apagar a entrada (ou desfazer o
-- pagamento da fatura) desfaz o acerto junto.
--
-- Só o servidor lê e escreve (RLS ligada, sem política aberta).
-- Sem esta migration: dividir responde "ainda está sendo liberado" e nada
-- quebra. Rodar de novo é seguro.

alter table public.transacoes add column if not exists dividida_com text;
alter table public.transacoes add column if not exists parte_outro numeric(14, 2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transacoes_divisao_check') then
    -- ⚠️ `is not null` explícito: num CHECK, comparação com nulo dá
    -- "desconhecido" e PASSA — sem ele, nome sem parte (ou parte sem nome) entrava.
    alter table public.transacoes add constraint transacoes_divisao_check check (
      (dividida_com is null and parte_outro is null)
      or (dividida_com is not null and parte_outro is not null
          and char_length(dividida_com) between 1 and 60 and parte_outro > 0)
    );
  end if;
end $$;

create table if not exists public.divisoes_acertos (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  cartao_id     uuid not null references public.wallets(id) on delete cascade,
  competencia   text not null check (competencia ~ '^\d{4}-\d{2}$'),
  pessoa        text not null check (char_length(pessoa) between 1 and 60),
  pessoa_chave  text not null,
  valor         numeric(14, 2) not null check (valor > 0),
  forma         text not null check (forma in ('conta', 'vincular', 'fatura', 'registro')),
  wallet_id     uuid references public.wallets(id) on delete set null,
  transacao_id  uuid references public.transacoes(id) on delete cascade,
  criado_por    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_divisoes_acertos_fatura
  on public.divisoes_acertos (grupo_id, cartao_id, competencia);
create index if not exists idx_divisoes_acertos_transacao
  on public.divisoes_acertos (transacao_id) where transacao_id is not null;
-- Sugestão de nomes ("com quem?") lê só as linhas divididas do grupo.
create index if not exists idx_transacoes_dividida
  on public.transacoes (grupo_id) where dividida_com is not null;

alter table public.divisoes_acertos enable row level security;
