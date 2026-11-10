-- 194 — ÚLTIMO USO DE VERDADE, pro painel admin.
--
-- O admin mostrava `auth.users.last_sign_in_at` como "último acesso", e esse
-- campo só muda quando a pessoa DIGITA A SENHA. Quem fica logado (app Android,
-- PWA) aparecia "há 68 dias" usando a Sora (caso real, nov/2026). E "última
-- transação" também não prova uso: a do Open Finance é o banco sincronizando.
--
-- 1) users.ultimo_acesso_em — abriu o painel (gravado 1×/dia por
--    /api/user/dispositivo). Daqui pra frente.
-- 2) admin_ultimo_uso(ids) — pro HISTÓRICO, já: a última renovação de sessão
--    (o app aberto renova o token de hora em hora, e isso fica em
--    auth.sessions) e o último lançamento feito pela PRÓPRIA pessoa (painel ou
--    WhatsApp; sem `of_tx_id`). `auth` não é exposto pela API, por isso a função.
--    SECURITY DEFINER e só pro service_role: lê só datas, nunca token.
-- Idempotente.

alter table public.users add column if not exists ultimo_acesso_em timestamptz;

create or replace function public.admin_ultimo_uso(ids uuid[])
returns table (user_id uuid, ultima_sessao timestamptz, ultimo_lancamento timestamptz)
language sql
security definer
set search_path = public, auth
as $$
  select u.id,
         (select max(coalesce(s.updated_at, s.created_at))
            from auth.sessions s where s.user_id = u.id),
         (select max(t.created_at) from public.transacoes t
            where t.criado_por = u.id and t.of_tx_id is null)
    from unnest(ids) as u(id);
$$;

revoke all on function public.admin_ultimo_uso(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_ultimo_uso(uuid[]) to service_role;
