-- =============================================================================
-- 159 — última cotação conhecida de cada moeda, PERSISTIDA.
--
-- `services/moeda.js` já prometia "devolve a ÚLTIMA conhecida, por velha que
-- seja — um número de ontem é muito melhor que sumir com o saldo". Só que a
-- memória dessa promessa era um `Map` do processo, e o backend roda no plano
-- FREE do Render, que HIBERNA: a cada cold start o mapa volta vazio, e aí toda
-- visita depende de uma chamada externa nova dar certo naquele instante.
--
-- Foi o que apagou o saldo de um cliente com contas em coroa norueguesa: ele
-- marcou a moeda certa e o painel respondeu "câmbio indisponível agora" nos
-- dois saldos. A cotação existia — a chamada é que falhou.
--
-- ⚠️ Uma linha por MOEDA, não por dia. Isto não é histórico de câmbio: é a
-- rede de segurança de "o que eu sabia por último". Guardar série temporal aqui
-- convidaria a usar a tabela pra conversão histórica, que é outro problema
-- (transação antiga tem `taxa_brl` congelada na própria linha).
--
-- ⚠️ A LEITURA E A ESCRITA SÃO TOLERANTES no código: sem esta migration o app
-- funciona igual ao de antes (cache só em memória). Ela melhora a resiliência,
-- não habilita a feature — de propósito, pra não repetir a família de bugs em
-- que a gravação falha calada porque a migration não rodou.
-- =============================================================================

create table if not exists public.cotacoes_moeda (
  moeda       text primary key,
  taxa_brl    numeric(18, 8) not null check (taxa_brl > 0),
  fonte       text,
  atualizado  timestamptz not null default now()
);

comment on table public.cotacoes_moeda is
  'Última cotação conhecida de cada moeda → BRL. Rede de segurança quando as fontes externas falham; não é histórico.';
comment on column public.cotacoes_moeda.fonte is
  'Qual fonte respondeu (yahoo | awesomeapi | er-api) — serve pra diagnosticar qual delas está bloqueada.';
