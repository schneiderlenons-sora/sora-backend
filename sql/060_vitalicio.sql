-- 060: plano VITALÍCIO (pagamento único, sem expiração).
-- O usuário paga uma vez (R$97) e ganha o Black pra sempre. Marcamos com a flag
-- `vitalicio` pra (1) exibir o selo e (2) BLINDAR contra downgrade quando uma
-- assinatura antiga for cancelada/atualizada. `plano` segue 'black' e
-- `plano_valido_ate` fica null (nunca expira). Idempotente.

alter table public.users add column if not exists vitalicio    boolean not null default false;
alter table public.users add column if not exists vitalicio_em  timestamptz;

-- Índice leve só pros vitalícios (contagem de "vagas de fundador" / métricas).
create index if not exists idx_users_vitalicio on public.users(vitalicio) where vitalicio = true;
