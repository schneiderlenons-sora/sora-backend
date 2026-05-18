-- =====================================================================
-- 001 — Auto-cria public.users + public.grupos quando um usuário se
-- registra em auth.users (signup pelo Supabase Auth).
--
-- Idempotente: pode ser executado várias vezes; só substitui a função e
-- recria o trigger.
--
-- Como aplicar:
--   Supabase Dashboard → SQL Editor → New Query → cole tudo abaixo → Run
-- =====================================================================

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
  -- Nome: prioriza raw_user_meta_data.name → full_name → parte do email
  v_name := coalesce(
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'full_name',
    split_part(coalesce(new.email, ''), '@', 1),
    'Usuário'
  );

  -- 1. Cria registro em public.users (sem grupo_ativo — FK circular)
  insert into public.users (id, name, email, phone, plano)
  values (new.id, v_name, coalesce(new.email, ''), '', 'inativo')
  on conflict (id) do nothing;

  -- 2. Cria grupo padrão com o user como dono
  insert into public.grupos (nome, dono_id)
  values ('Pessoal de ' || v_name, new.id)
  returning id into v_grupo_id;

  -- 3. Linka o user ao grupo recém-criado
  update public.users
     set grupo_ativo = v_grupo_id
   where id = new.id;

  -- 4. Popula categorias padrão no grupo
  perform public.criar_categorias_padrao(v_grupo_id);

  return new;
end;
$$;

-- Permite que o trigger consiga inserir mesmo com RLS ativo
grant usage on schema public to supabase_auth_admin;
grant execute on function public.handle_new_user() to supabase_auth_admin;

-- Recria o trigger garantindo idempotência
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- =====================================================================
-- Verificação rápida (rode após aplicar):
--
--   select * from pg_trigger
--    where tgname = 'on_auth_user_created';
--
-- Para testar criando um usuário fake (substitua o email):
--
--   select id from auth.users where email = 'novo@teste.com';
--   select id, name, grupo_ativo from public.users where id = '<uuid_acima>';
--   select count(*) from public.categorias
--    where grupo_id = (select grupo_ativo from public.users where id = '<uuid_acima>');
-- =====================================================================
