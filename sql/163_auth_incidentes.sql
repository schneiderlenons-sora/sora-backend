-- =============================================================================
-- 163 — `auth_incidentes`: o instante exato em que alguém é deslogado sem ter
-- pedido. É INSTRUMENTAÇÃO, não correção.
--
-- POR QUE EXISTE. O relato "clico no menu no celular e a Sora pede login de
-- novo" já teve CINCO rodadas de correção (dois clientes: dutra.tim e
-- weslley.jean1). Cada rodada nasceu de uma teoria plausível, e as duas
-- principais foram DERRUBADAS por medição depois:
--
--   · "é a VPN / latência"         → o cliente respondeu que não usa VPN;
--   · "a corrida de rotação do refresh token revoga a sessão" → testado contra
--     o Auth deste projeto: renovar DUAS vezes com o mesmo token, 15s depois
--     (fora da janela de reuso de 10s), devolveu HTTP 200 nas duas, o mesmo
--     token rotacionado, e a sessão do vencedor continuou válida. Este projeto
--     NÃO revoga sessão por reuso.
--
-- Ou seja: a causa raiz segue desconhecida, e o bug nunca foi reproduzido aqui
-- — tudo que se sabe veio de duas frases de e-mail. Continuar corrigindo no
-- escuro é o que produziu cinco rodadas. Esta tabela troca teoria por fato.
--
-- O QUE É GRAVADO. Só no instante da anomalia, que o middleware já sabe
-- detectar: a requisição chegou COM cookie de sessão e mesmo assim a validação
-- voltou vazia. Nada é gravado no caminho feliz.
--
-- ⚠️ NÃO GUARDA TOKEN. Nem access, nem refresh, nem o cookie. Só quem
-- (e-mail/id lidos do próprio cookie, pra saber de QUEM é o incidente), qual
-- rota, se era navegação real ou palpite do roteador, e o user-agent — que é o
-- que separa iPhone × Android e navegador × app instalado, as hipóteses que
-- sobraram.
--
-- Volume esperado: baixíssimo (é a falha). Se esta tabela crescer rápido, isso
-- por si só já é a descoberta.
-- =============================================================================

create table if not exists public.auth_incidentes (
  id          uuid primary key default gen_random_uuid(),
  criado_em   timestamptz not null default now(),
  user_id     uuid,
  email       text,
  rota        text,
  -- true = `next-router-prefetch`, ou seja, o roteador do Next adivinhando, não
  -- um toque da pessoa. Separar os dois é essencial: palpite não deveria nunca
  -- levar a logout, e se aparecer aqui já diz muito.
  palpite     boolean,
  user_agent  text,
  -- Quantos cookies de sessão vieram. > 1 significa FATIAMENTO (a sessão passou
  -- de 4 KB) ou cookie duplicado em escopos diferentes (apex × www) — as duas
  -- coisas corrompem sessão e não dá pra ver de fora.
  cookies     int
);

create index if not exists auth_incidentes_criado_idx
  on public.auth_incidentes (criado_em desc);
create index if not exists auth_incidentes_email_idx
  on public.auth_incidentes (email);

comment on table public.auth_incidentes is
  'Instrumentação do bug "desloga ao clicar no menu". Uma linha por requisição que chegou com cookie de sessão e falhou a validação. Não guarda token.';
