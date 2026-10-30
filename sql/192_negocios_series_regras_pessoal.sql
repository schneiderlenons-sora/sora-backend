-- 192 — Sora Negócios: contas que se repetem, "aprende" pela descrição e conta
-- da empresa fora das finanças pessoais (pedidos do Robert, out/2026).
--
-- Três partes independentes. O código tolera cada uma faltando: sem esta
-- migration, tudo funciona como antes e as telas dizem o que falta.
-- Idempotente.

-- ── 1. CONTAS QUE SE REPETEM ────────────────────────────────────────────────
-- `recorrente`/`recorrencia` existiam desde a 091, mas nada gerava as próximas:
-- o contrato recebido toda semana tinha de ser cadastrado semana a semana.
-- Agora cada ocorrência leva o id da SÉRIE; o servidor gera as próximas até um
-- horizonte (semanal ~13 semanas, mensal ~6 meses, anual ~13 meses) e um job
-- diário mantém esse horizonte andando.
--   serie_id  → agrupa as ocorrências da mesma conta que se repete
--   serie_ate → até quando repete (null = sem data de fim)
alter table public.lancamentos_negocio
  add column if not exists serie_id uuid,
  add column if not exists serie_ate date;

create index if not exists idx_lanc_serie
  on public.lancamentos_negocio(serie_id) where serie_id is not null;

-- ── 2. "APRENDE" PELA DESCRIÇÃO ─────────────────────────────────────────────
-- O que vem do banco entra "a classificar". Classificar um e marcar "as
-- próximas iguais também" grava a regra aqui; as próximas já entram com a
-- categoria. Por EMPRESA (a categoria de uma loja não serve pra outra).
create table if not exists public.regras_negocio (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  termo       text not null,           -- descrição normalizada (regrasCategoria.termoDe)
  tipo        text check (tipo in ('entrada', 'saida')),  -- null = vale pros dois sentidos
  categoria   text not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create unique index if not exists uq_regras_negocio
  on public.regras_negocio(empresa_id, termo, coalesce(tipo, ''));

-- ── 3. CONTA DA EMPRESA FORA DAS FINANÇAS PESSOAIS (passo B) ────────────────
-- Conta do banco vinculada ao caixa da empresa (189) continuava somando nas
-- finanças PESSOAIS: o mesmo Pix era receita da empresa e receita da pessoa.
-- Com o vínculo, cada transação que entra no caixa ganha
-- `transacoes.ignorar_em = 'empresa'` — o "não considerar" que todos os totais
-- pessoais já respeitam —, e desvincular tira exatamente essa marca.
-- Ligado por padrão; quem usa uma conta MISTA (pessoal e empresa) desliga.
alter table public.contas_negocio
  add column if not exists fora_do_pessoal boolean not null default true;
