-- 059: final do cartão (cartão virtual) na transação do Open Finance.
-- A Nubank expõe creditCardMetadata.cardNumber por transação. A fatura/limite
-- é compartilhada (1 conta), mas guardamos o final pra dar pra VER/filtrar por
-- cartão virtual. Idempotente.

alter table public.transacoes add column if not exists pluggy_card text;
create index if not exists idx_transacoes_pluggy_card on public.transacoes(pluggy_card) where pluggy_card is not null;
