-- 205 — Aniversários e datas comemorativas (aba da Agenda do Grow).
--
-- Pedido de cliente (nov/2026): datas que se repetem todo ano, com lembrete
-- uma semana antes e no próprio dia. Regra em services/aniversarios.js.
--
-- Pessoal (por user_id), como a Agenda. Só o servidor lê e escreve (RLS
-- ligada, sem política aberta). `aviso_*_ano` = o ano em que aquele lembrete
-- já saiu (um por ano, reservado antes de enviar).
--
-- Sem esta migration: a aba Aniversários diz que ainda está sendo liberada e
-- o cron não faz nada. Rodar de novo é seguro.

create table if not exists public.aniversarios (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  grupo_id         uuid references public.grupos(id) on delete set null,
  nome             text not null check (char_length(nome) between 1 and 80),
  tipo             text not null default 'aniversario' check (tipo in ('aniversario', 'casamento', 'data')),
  dia              smallint not null check (dia between 1 and 31),
  mes              smallint not null check (mes between 1 and 12),
  ano              smallint check (ano between 1900 and 2100),
  lembrete_semana  boolean not null default true,
  lembrete_dia     boolean not null default true,
  observacao       text check (observacao is null or char_length(observacao) <= 500),
  aviso_semana_ano smallint,
  aviso_dia_ano    smallint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_aniversarios_user on public.aniversarios (user_id, mes, dia);
create index if not exists idx_aniversarios_data on public.aniversarios (mes, dia);

alter table public.aniversarios enable row level security;
