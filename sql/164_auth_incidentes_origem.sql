-- =============================================================================
-- 164 — `origem` e `detalhe` em `auth_incidentes`.
--
-- POR QUE EXISTE. A 163 instrumentou o SERVIDOR: uma linha por requisição que
-- chega com cookie de sessão e falha a validação. Ela funciona — conferido de
-- ponta a ponta em produção, com um cookie falso: gravou a linha.
--
-- E foi justamente ela funcionando e ficando VAZIA, depois de o cliente
-- reproduzir o bug, que entregou a causa raiz. Zero linha significa que a
-- requisição chegou SEM cookie nenhum: o cookie já tinha sido apagado ANTES, no
-- navegador, pelo próprio supabase-js — que faz isso quando a renovação de
-- token volta com um status fora da lista curta dele de "erros temporários"
-- (429 e 500 NÃO estão nessa lista).
--
-- Esse instante não tem como ser visto do servidor: a navegação seguinte sai
-- limpa e é indistinguível de alguém que nunca logou. Por isso agora o
-- NAVEGADOR também reporta (`lib/supabase.ts` → `/api/auth-incidente`), e a
-- tabela precisa dizer de qual dos dois lados veio cada linha.
--
--   origem  = 'middleware' (servidor, caminho da 163) | 'navegador' (cliente)
--   detalhe = o status HTTP que causou, ex. 'renovacao adiada HTTP 429'
--
-- É o campo que vai responder, com FATO, qual status atinge o cliente — em vez
-- de esperarmos mais um e-mail pra descobrir.
--
-- ⚠️ CONTINUA SEM GUARDAR TOKEN. Nem access, nem refresh, nem o cookie.
--
-- Idempotente e aditiva: `add column if not exists`, sem default destrutivo,
-- sem tocar nas linhas existentes.
-- =============================================================================

alter table public.auth_incidentes
  add column if not exists origem  text,
  add column if not exists detalhe text;

comment on column public.auth_incidentes.origem is
  'De qual lado veio: middleware (servidor) ou navegador (cliente).';
comment on column public.auth_incidentes.detalhe is
  'O que aconteceu — tipicamente o status HTTP da renovacao que falhou.';

create index if not exists auth_incidentes_origem_idx
  on public.auth_incidentes (origem, criado_em desc);
