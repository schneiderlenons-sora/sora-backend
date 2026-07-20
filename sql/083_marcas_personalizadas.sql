-- =====================================================================
-- 083 — Marcas personalizadas (ícone de loja custom por grupo)
--
-- Deixa o usuário subir a logo de uma loja (ex.: mercado do bairro) e casá-la
-- por NOME: toda transação cujo texto contém o `termo` mostra a `logo_url`
-- (dataURL), igual às marcas famosas embutidas — só que definida pelo usuário.
-- Idempotente.
-- =====================================================================

create table if not exists public.marcas_personalizadas (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  user_id    uuid references public.users(id) on delete set null,
  termo      text not null,   -- nome da loja pra casar no texto da transação
  logo_url   text not null,   -- PNG em dataURL (transparência preservada)
  created_at timestamptz default now()
);

create index if not exists idx_marcas_person_grupo on public.marcas_personalizadas(grupo_id);

alter table public.marcas_personalizadas enable row level security;
drop policy if exists "service_role_all_marcas_personalizadas" on public.marcas_personalizadas;
create policy "service_role_all_marcas_personalizadas" on public.marcas_personalizadas
  for all to service_role using (true) with check (true);
