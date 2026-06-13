-- =====================================================================
-- 039 — Privacidade do Sora Grow em grupos.
--
-- Adiciona user_id (dono/criador) nas tabelas do Grow que hoje só têm
-- grupo_id. As abas pessoais (Hábitos, Tarefas, Agenda) passam a ler por
-- user_id; as opcionais (Casa + Coleções) leem por user_id OU grupo_id
-- conforme o toggle do grupo (migration 040).
--
-- Backfill: linhas existentes recebem user_id = dono do grupo (grupos.dono_id),
-- exceto tarefas que herdam de criado_por quando houver. Em grupo solo
-- (1 membro) o dono é o próprio usuário, então nada muda na prática.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── Hábitos (lista + check-ins) ──────────────────────────────────────
alter table public.habitos add column if not exists user_id uuid references public.users(id);
update public.habitos h set user_id = g.dono_id
  from public.grupos g where h.grupo_id = g.id and h.user_id is null;
create index if not exists idx_habitos_user on public.habitos(user_id);

alter table public.registros_habito add column if not exists user_id uuid references public.users(id);
update public.registros_habito r set user_id = g.dono_id
  from public.grupos g where r.grupo_id = g.id and r.user_id is null;
create index if not exists idx_registros_habito_user on public.registros_habito(user_id);

-- ── Tarefas + Projetos ───────────────────────────────────────────────
alter table public.tarefas add column if not exists user_id uuid references public.users(id);
update public.tarefas t set user_id = coalesce(t.criado_por, g.dono_id)
  from public.grupos g where t.grupo_id = g.id and t.user_id is null;
create index if not exists idx_tarefas_user on public.tarefas(user_id);

alter table public.projetos add column if not exists user_id uuid references public.users(id);
update public.projetos p set user_id = g.dono_id
  from public.grupos g where p.grupo_id = g.id and p.user_id is null;
create index if not exists idx_projetos_user on public.projetos(user_id);

-- ── Agenda / Compromissos ────────────────────────────────────────────
alter table public.compromissos add column if not exists user_id uuid references public.users(id);
update public.compromissos c set user_id = g.dono_id
  from public.grupos g where c.grupo_id = g.id and c.user_id is null;
create index if not exists idx_compromissos_user on public.compromissos(user_id);

-- ── Casa: Despensa, Manutenções, Receitas, Itens da lista de compras ─
alter table public.despensa_itens add column if not exists user_id uuid references public.users(id);
update public.despensa_itens d set user_id = g.dono_id
  from public.grupos g where d.grupo_id = g.id and d.user_id is null;
create index if not exists idx_despensa_user on public.despensa_itens(user_id);

alter table public.manutencoes add column if not exists user_id uuid references public.users(id);
update public.manutencoes m set user_id = g.dono_id
  from public.grupos g where m.grupo_id = g.id and m.user_id is null;
create index if not exists idx_manutencoes_user on public.manutencoes(user_id);

alter table public.receitas add column if not exists user_id uuid references public.users(id);
update public.receitas r set user_id = g.dono_id
  from public.grupos g where r.grupo_id = g.id and r.user_id is null;
create index if not exists idx_receitas_user on public.receitas(user_id);

-- itens_lista_compras não tem grupo_id direto → herda via listas_compras
alter table public.itens_lista_compras add column if not exists user_id uuid references public.users(id);
update public.itens_lista_compras i set user_id = g.dono_id
  from public.listas_compras l join public.grupos g on g.id = l.grupo_id
  where i.lista_id = l.id and i.user_id is null;
create index if not exists idx_itens_lista_user on public.itens_lista_compras(user_id);

-- ── Coleções: Viagens, Bucket list, Mídia, Leituras ──────────────────
alter table public.viagens add column if not exists user_id uuid references public.users(id);
update public.viagens v set user_id = g.dono_id
  from public.grupos g where v.grupo_id = g.id and v.user_id is null;
create index if not exists idx_viagens_user on public.viagens(user_id);

alter table public.bucket_list add column if not exists user_id uuid references public.users(id);
update public.bucket_list b set user_id = g.dono_id
  from public.grupos g where b.grupo_id = g.id and b.user_id is null;
create index if not exists idx_bucket_user on public.bucket_list(user_id);

alter table public.midia add column if not exists user_id uuid references public.users(id);
update public.midia m set user_id = g.dono_id
  from public.grupos g where m.grupo_id = g.id and m.user_id is null;
create index if not exists idx_midia_user on public.midia(user_id);

alter table public.leituras add column if not exists user_id uuid references public.users(id);
update public.leituras le set user_id = g.dono_id
  from public.grupos g where le.grupo_id = g.id and le.user_id is null;
create index if not exists idx_leituras_user on public.leituras(user_id);
