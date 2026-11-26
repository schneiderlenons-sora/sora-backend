-- =============================================================================
-- 201 — Widgets do iPhone e do Android (fase 2: os widgets com números)
--
-- Três peças:
--
-- 1. widget_conexoes / widget_codigos — a chave do widget. Igual à conexão do
--    ChatGPT/Claude: chave OPACA, guardada só como sha256 (vazou a tabela, não
--    vazou acesso), só vale nos endereços /api/widget/*, revogável aparelho por
--    aparelho. O código de conexão é de uso único e vale 5 minutos.
--
-- 2. grupo_versao — um número por grupo que o PRÓPRIO BANCO aumenta quando algo
--    que aparece nos widgets muda (lançamento, conta, conta fixa, dívida, fatura,
--    limite do mês). É o que barateia os widgets: o aparelho pergunta "mudou?"
--    a cada hora (1 consulta, ~1 KB) e o servidor só recalcula quando mudou.
--    Medido antes: recalcular tudo custa 12–14 consultas (18 KB numa conta
--    típica, 67 KB na maior). Gatilho no banco, e não no código, porque são
--    dezenas de caminhos que gravam (WhatsApp, painel, sincronização do banco,
--    crons) — esquecer um deixaria o widget velho sem ninguém notar.
--
--    ⚠️ O gatilho NUNCA derruba a gravação do cliente: qualquer erro dentro
--    dele é engolido (o pior caso é o widget atualizar só no dia seguinte).
--    ⚠️ UPDATE só conta quando algo além das colunas de controle mudou: a
--    sincronização do banco regrava contas e faturas iguais a cada hora, e
--    contar isso faria o widget recalcular à toa.
--    ⚠️ `of_parcelas_previstas` fica de fora de propósito: ela é apagada e
--    regravada a cada sincronização. Parcela nova só nasce junto de compra
--    nova (que já marca), e a virada do dia recalcula de qualquer jeito.
--
-- 3. widget_contexto(hash) — UMA ida ao banco por consulta do widget: valida a
--    chave, lê o plano e a versão do grupo, e anota o último uso (no máximo 1×
--    por hora, pra não virar uma escrita por consulta).
--
-- Aplicar: Supabase → SQL Editor → Run. Rodar de novo é seguro.
-- =============================================================================

-- ── 1. Chaves e códigos ─────────────────────────────────────────────────────
create table if not exists public.widget_conexoes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  token_hash    text not null unique,
  plataforma    text not null check (plataforma in ('ios', 'android')),
  aparelho      text,
  criado_em     timestamptz not null default now(),
  ultimo_uso_em timestamptz,
  revogado_em   timestamptz
);
create index if not exists widget_conexoes_user on public.widget_conexoes (user_id);

create table if not exists public.widget_codigos (
  codigo_hash text primary key,
  user_id     uuid not null references public.users(id) on delete cascade,
  criado_em   timestamptz not null default now(),
  expira_em   timestamptz not null,
  usado_em    timestamptz
);

alter table public.widget_conexoes enable row level security;
alter table public.widget_codigos  enable row level security;

-- ── 2. Versão por grupo ─────────────────────────────────────────────────────
create table if not exists public.grupo_versao (
  grupo_id      uuid primary key,
  versao        bigint not null default 1,
  atualizado_em timestamptz not null default now()
);
alter table public.grupo_versao enable row level security;

create or replace function public.tocar_grupo_versao(p_grupo uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.grupo_versao (grupo_id, versao, atualizado_em) values (p_grupo, 1, now())
  on conflict (grupo_id) do update set versao = public.grupo_versao.versao + 1, atualizado_em = now();
$$;

-- Colunas de controle: mudar SÓ elas não muda nenhum número dos widgets.
create or replace function public.widget_colunas_controle()
returns text[] language sql immutable as $$
  select array['updated_at', 'atualizado_em', 'ultimo_aviso_fechamento', 'ultimo_aviso_vencimento',
               'ultimo_lembrete_dia', 'ultimo_aviso_em', 'avisado_em', 'lembrete_enviado']::text[];
$$;

-- Tabelas com grupo_id.
create or replace function public.widget_marca_grupo()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ign text[] := public.widget_colunas_controle();
begin
  begin
    if TG_OP = 'INSERT' then
      perform public.tocar_grupo_versao(x.g)
        from (select distinct grupo_id as g from novos where grupo_id is not null) x;
    elsif TG_OP = 'DELETE' then
      perform public.tocar_grupo_versao(x.g)
        from (select distinct grupo_id as g from antigos where grupo_id is not null) x;
    else
      perform public.tocar_grupo_versao(x.g) from (
        select n.grupo_id as g from novos n join antigos o on o.id = n.id
         where n.grupo_id is not null and (to_jsonb(n) - ign) is distinct from (to_jsonb(o) - ign)
        union
        select o.grupo_id from novos n join antigos o on o.id = n.id
         where o.grupo_id is not null and o.grupo_id is distinct from n.grupo_id
      ) x;
    end if;
  exception when others then
    null; -- nunca derruba a gravação do cliente
  end;
  return null;
end $$;

-- Pagamento de parcela: o grupo vem pela dívida.
create or replace function public.widget_marca_divida_pagamento()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if TG_OP = 'DELETE' then
      perform public.tocar_grupo_versao(x.g) from (
        select distinct d.grupo_id as g from antigos a join public.dividas d on d.id = a.divida_id where d.grupo_id is not null) x;
    else
      perform public.tocar_grupo_versao(x.g) from (
        select distinct d.grupo_id as g from novos n join public.dividas d on d.id = n.divida_id where d.grupo_id is not null) x;
    end if;
  exception when others then
    null;
  end;
  return null;
end $$;

-- Limite geral do mês (mora na conta da pessoa): marca o grupo ativo dela.
create or replace function public.widget_marca_meta_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.tocar_grupo_versao(x.g) from (
      select distinct n.grupo_ativo as g from novos n join antigos o on o.id = n.id
       where n.grupo_ativo is not null and n.meta_mensal is distinct from o.meta_mensal) x;
  exception when others then
    null;
  end;
  return null;
end $$;

-- Gatilhos (um por evento: tabela de transição só existe com um evento por gatilho).
do $$
declare t text;
begin
  foreach t in array array['transacoes', 'wallets', 'recorrencias', 'dividas', 'previsao_ajustes',
                           'pagamentos_fatura', 'of_faturas', 'fatura_rollover'] loop
    execute format('drop trigger if exists widget_versao_ins on public.%I', t);
    execute format('drop trigger if exists widget_versao_upd on public.%I', t);
    execute format('drop trigger if exists widget_versao_del on public.%I', t);
    execute format('create trigger widget_versao_ins after insert on public.%I referencing new table as novos for each statement execute function public.widget_marca_grupo()', t);
    execute format('create trigger widget_versao_upd after update on public.%I referencing old table as antigos new table as novos for each statement execute function public.widget_marca_grupo()', t);
    execute format('create trigger widget_versao_del after delete on public.%I referencing old table as antigos for each statement execute function public.widget_marca_grupo()', t);
  end loop;
end $$;

drop trigger if exists widget_versao_ins on public.divida_pagamentos;
drop trigger if exists widget_versao_upd on public.divida_pagamentos;
drop trigger if exists widget_versao_del on public.divida_pagamentos;
create trigger widget_versao_ins after insert on public.divida_pagamentos
  referencing new table as novos for each statement execute function public.widget_marca_divida_pagamento();
create trigger widget_versao_upd after update on public.divida_pagamentos
  referencing old table as antigos new table as novos for each statement execute function public.widget_marca_divida_pagamento();
create trigger widget_versao_del after delete on public.divida_pagamentos
  referencing old table as antigos for each statement execute function public.widget_marca_divida_pagamento();

drop trigger if exists widget_versao_meta on public.users;
create trigger widget_versao_meta after update on public.users
  referencing old table as antigos new table as novos for each statement execute function public.widget_marca_meta_usuario();

-- ── 3. Uma ida por consulta do widget ───────────────────────────────────────
create or replace function public.widget_contexto(p_hash text)
returns json language plpgsql security definer set search_path = public as $$
declare
  r record;
  v bigint;
begin
  select c.id as conexao_id, c.user_id, c.revogado_em, c.ultimo_uso_em,
         u.email, u.grupo_ativo, u.plano, u.vitalicio, u.stripe_subscription_id,
         u.plano_fonte, u.plano_valido_ate, u.meta_mensal
    into r
    from public.widget_conexoes c
    join public.users u on u.id = c.user_id
   where c.token_hash = p_hash;
  if not found or r.revogado_em is not null then
    return null;
  end if;
  if r.ultimo_uso_em is null or r.ultimo_uso_em < now() - interval '1 hour' then
    update public.widget_conexoes set ultimo_uso_em = now() where id = r.conexao_id;
  end if;
  select g.versao into v from public.grupo_versao g where g.grupo_id = r.grupo_ativo;
  return json_build_object(
    'conexao_id', r.conexao_id, 'user_id', r.user_id, 'email', r.email, 'grupo_id', r.grupo_ativo,
    'plano', r.plano, 'vitalicio', r.vitalicio, 'assinatura_stripe', r.stripe_subscription_id is not null,
    'plano_fonte', r.plano_fonte, 'plano_valido_ate', r.plano_valido_ate, 'meta_mensal', r.meta_mensal,
    'versao', coalesce(v, 0));
end $$;

revoke all on function public.widget_contexto(text) from public, anon, authenticated;
revoke all on function public.tocar_grupo_versao(uuid) from public, anon, authenticated;

comment on table public.widget_conexoes is 'Widgets do iPhone/Android (migration 201): uma linha por aparelho conectado. Chave só em sha256.';
comment on table public.grupo_versao is 'Widgets (migration 201): aumenta quando algo que os widgets mostram muda — o widget só recalcula quando muda.';
