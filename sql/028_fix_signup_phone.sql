-- =====================================================================
-- 028 — Corrige "Database error saving new user" no signup
--
-- CAUSA: a coluna users.phone tem UNIQUE (users_phone_key) e o trigger
-- handle_new_user inseria phone = '' (string vazia) pra todo novo user.
-- O 1º user sem WhatsApp ocupava o '' e o 2º signup colidia no unique,
-- quebrando o cadastro (email/senha E Google passam pelo mesmo trigger).
--
-- FIX: trigger passa a inserir phone = NULL (Postgres permite vários NULL
-- num índice unique), limpamos os '' existentes e trocamos a constraint
-- por um índice unique PARCIAL que ignora vazios/nulos.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- 1. Normaliza phones vazios pra NULL (libera o slot do '')
update public.users set phone = null where phone = '';

-- 2. Recria a função do trigger usando NULL em vez de '' no phone
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grupo_id uuid;
  v_name     text;
begin
  v_name := coalesce(
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'full_name',
    split_part(coalesce(new.email, ''), '@', 1),
    'Usuário'
  );

  -- phone NULL (não '') — evita colisão no unique entre users sem WhatsApp
  insert into public.users (id, name, email, phone, plano)
  values (new.id, v_name, coalesce(new.email, ''), null, 'inativo')
  on conflict (id) do nothing;

  insert into public.grupos (nome, dono_id)
  values ('Pessoal de ' || v_name, new.id)
  returning id into v_grupo_id;

  update public.users
     set grupo_ativo = v_grupo_id
   where id = new.id;

  perform public.criar_categorias_padrao(v_grupo_id);

  return new;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.handle_new_user() to supabase_auth_admin;

-- 3. Troca o unique cheio por um unique PARCIAL (ignora vazios/nulos).
--    Assim nunca mais dois users "sem telefone" colidem, mas telefones
--    reais continuam únicos (um WhatsApp = um user).
alter table public.users drop constraint if exists users_phone_key;
drop index   if exists public.users_phone_key;
create unique index if not exists users_phone_key
  on public.users (phone)
  where phone is not null and phone <> '';

-- =====================================================================
-- Verificação:
--   select count(*) from public.users where phone = '';   -- deve ser 0
--   -- e tente criar 2 usuários novos no app — ambos devem funcionar.
-- =====================================================================
