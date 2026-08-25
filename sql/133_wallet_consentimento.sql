-- =============================================================================
-- 133 — De QUAL consentimento veio cada carteira do Open Finance.
--
-- POR QUE: hoje sabemos o banco de cada CONEXÃO (`of_conexoes.instituicao`),
-- mas não guardamos de qual conexão veio cada carteira. Num grupo com mais de
-- um banco conectado não há como saber se aquele cartão é do Nubank ou do
-- Itaú — e sem isso não dá pra nomear "Nubank Crédito" sem chutar.
--
-- Medido em 25/08/2026: dos 29 cartões de Open Finance, 16 estão em grupos com
-- 2 ou 3 bancos conectados. Ou seja, mais da metade era impossível de atribuir.
--
-- Idempotente. Não quebra nada em quem ainda não rodou: o sync grava a coluna
-- de forma tolerante (o upsert cai pro update sem extras se ela não existir).
-- =============================================================================

alter table public.wallets
  add column if not exists of_consent_id text;

comment on column public.wallets.of_consent_id is
  'external_id do consentimento (of_conexoes.external_id) que trouxe esta carteira. Usado pra saber de QUE BANCO ela é quando o grupo tem várias conexões.';

-- Índice pequeno: o sync e o script de renomeação filtram por ele.
create index if not exists idx_wallets_of_consent
  on public.wallets (of_consent_id)
  where of_consent_id is not null;

-- ── BACKFILL do que já dá pra deduzir com segurança ──────────────────────────
-- Só preenche quando o grupo tem UMA conexão Open Finance: aí não há
-- ambiguidade possível. Grupo com 2+ bancos fica null e é resolvido no próximo
-- sync, que sabe de qual consentimento cada cartão veio.
update public.wallets w
set of_consent_id = c.external_id
from (
  select grupo_id, min(external_id) as external_id, count(*) as n
  from public.of_conexoes
  group by grupo_id
) c
where w.grupo_id = c.grupo_id
  and c.n = 1
  and w.of_conta_id is not null
  and w.of_consent_id is null;
