-- 193 — Reservas (caixinhas) da conta da empresa também no pessoal (nov/2026)
--
-- Relato do Robert: a caixinha da conta PJ aparecia na aba Investimentos
-- pessoal. Desde então a reserva de uma conta "só da empresa" fica no Sora
-- Negócios (services/contaDaEmpresa.js). Esta coluna é a OPÇÃO do dono de
-- vê-la também na aba pessoal — só visual: o total pessoal de caixinhas nunca a
-- soma, a tela a mostra num bloco à parte, com o nome da empresa.
--
-- Padrão FALSE (fica só no Negócios). Sem esta migration tudo funciona; só a
-- opção responde "ainda está sendo liberado".
--
-- Idempotente.

alter table public.contas_negocio
  add column if not exists reservas_no_pessoal boolean not null default false;

comment on column public.contas_negocio.reservas_no_pessoal is
  'Mostrar as reservas (caixinhas) da conta do banco vinculada também na aba Investimentos pessoal. Só visual.';
