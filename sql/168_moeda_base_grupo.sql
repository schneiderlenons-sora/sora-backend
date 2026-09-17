-- =============================================================================
-- 168 — MOEDA BASE do grupo.
--
-- Até aqui a Sora tinha moeda por CARTEIRA (migration 144): dava pra ter uma
-- conta em dólar, mas tudo era convertido pra real pra somar, e `BRL` era uma
-- constante global do código. Esta coluna é o que permite um grupo inteiro
-- viver em outra moeda — USD e NOK são as duas primeiras (decisão do dono).
--
-- ⚠️ A MOEDA É DO GRUPO, NÃO DO USUÁRIO. Duas pessoas compartilham um grupo e
-- leem as MESMAS linhas de `transacoes`. Com a moeda no usuário, o mesmo
-- `valor = 1000` sairia R$ 1.000 pra um e US$ 1.000 pro outro — dois números
-- pro mesmo dinheiro. O IDIOMA continua sendo do usuário; são eixos separados.
--
-- ⚠️ O QUE ESTA COLUNA MUDA NO SIGNIFICADO DE `transacoes.valor`:
-- as migrations 144 e 160 cravam que ele é "SEMPRE em BRL". Passa a ser
-- "sempre na MOEDA BASE DO GRUPO". Todos os consumidores (dashboard,
-- categorias, relatórios, limites, Wrapped, Oráculo) seguem corretos SEM
-- alteração, porque um grupo nunca mistura bases e nada no sistema soma
-- dinheiro entre grupos — conferido: o /admin só soma preço de plano.
-- Pros 217 grupos de hoje o valor é 'BRL' e nada muda.
--
-- ⚠️ SEM CHECK CONSTRAINT, de propósito. Quatro incidentes desta base
-- (users_plano_check, investimentos_tipo_check, dividas_tipo_check e o
-- plano 'gratis') foram gravação falhando CALADA porque um valor novo não
-- estava no CHECK. A validação mora em `normalizarMoeda`, no código.
--
-- ⚠️ TROCAR A BASE DEPOIS DE TER LANÇAMENTO ESTÁ TRAVADO NO MVP (decisão do
-- dono). São 51 colunas de dinheiro em 40 tabelas que precisariam ser
-- reescritas juntas; a trava mora no código, não aqui.
--
-- Idempotente.
-- =============================================================================

alter table public.grupos
  add column if not exists moeda_base text not null default 'BRL';

comment on column public.grupos.moeda_base is
  'Moeda em que este grupo vive (ISO 4217). `transacoes.valor`, `recorrencias.valor` e todo valor do grupo estão NESTA moeda. Default BRL.';

-- Garante que ninguém ficou com null (a coluna é NOT NULL, mas um backfill
-- anterior mal feito poderia ter deixado vazio em base já migrada).
update public.grupos set moeda_base = 'BRL'
 where moeda_base is null or btrim(moeda_base) = '';
