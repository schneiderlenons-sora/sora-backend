-- =====================================================================
-- 022 — State machine pra conversas pendentes da Sora
-- Quando a Sora precisa perguntar algo (ex.: "de qual conta saiu?",
-- "quer marcar como principal?"), guarda o contexto aqui pra processar
-- a resposta do usuário na próxima mensagem.
-- TTL curto (10min) — se o user mudar de assunto, deixa expirar.
-- =====================================================================

create table if not exists public.transacoes_pendentes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  transacao_id  uuid references public.transacoes(id) on delete cascade,
  tipo_pergunta text not null check (tipo_pergunta in (
    'escolher_conta',
    'marcar_principal',
    'criar_conta'
  )),
  contexto      jsonb default '{}'::jsonb,
  expires_at    timestamptz not null default (now() + interval '10 minutes'),
  created_at    timestamptz not null default now()
);

-- Índice pra busca rápida por user (lookup por última mensagem)
create index if not exists transacoes_pendentes_user_idx
  on public.transacoes_pendentes (user_id, expires_at);

-- =====================================================================
-- Limpeza periódica (rodar diariamente ou em job):
--   delete from public.transacoes_pendentes where expires_at < now();
-- =====================================================================
