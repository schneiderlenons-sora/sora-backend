-- =============================================================================
-- 169 — conta nova sem moeda nasce na MOEDA BASE do grupo, não em real.
--
-- A migration 144 criou `wallets.moeda text not null default 'BRL'`. Com a
-- moeda base por grupo (168), o default virou armadilha: uma conta criada SEM
-- informar moeda nascia em real mesmo num grupo que vive em dólar. São 8
-- caminhos de código que criam carteira sem mandar a moeda — o "Dinheiro"
-- criado sozinho quando alguém lança pelo WhatsApp, "nubank 1000", o cartão do
-- painel, o onboarding, o `garantirCarteira` do cron, a conta de destino de uma
-- transferência… Num grupo em dólar, cada um deles criaria uma conta em real e
-- todo lançamento nela seria CONVERTIDO de real pra dólar: número plausível,
-- errado e congelado na linha.
--
-- ⚠️ POR QUE GATILHO E NÃO CÓDIGO. Corrigir os 8 caminhos resolveria hoje e
-- quebraria no 9º. O gatilho vale pra qualquer insert, inclusive os que ainda
-- não existem.
--
-- ⚠️ POR QUE TIRAR O DEFAULT. Com o default, o gatilho recebe 'BRL' e não tem
-- como distinguir "não informou" de "escolheu real". Sem ele, `moeda` chega
-- NULL quando ninguém informou, e o gatilho preenche com a base. Quem INFORMA a
-- moeda (o cadastro de conta do painel, o Open Finance — banco brasileiro é
-- BRL) continua mandando no valor.
--
-- ⚠️ ORDEM: o gatilho é criado ANTES de o default cair — nunca existe um
-- instante em que um insert sem moeda violaria o NOT NULL.
--
-- ⚠️ `upsert` de conta que JÁ EXISTE não é afetado: o gatilho preenche a linha
-- proposta, mas o `on conflict do update` só reescreve as colunas que vieram no
-- payload. A moeda de uma conta existente nunca muda por aqui.
--
-- ⚠️ À PROVA DE FALHA: qualquer erro na leitura do grupo cai em 'BRL' — o
-- comportamento de antes desta migration. Um erro aqui não pode impedir alguém
-- de criar conta.
--
-- Pros 217 grupos de hoje (todos em real) nada muda: a base é 'BRL', igual ao
-- default antigo. Garante a coluna da 168 caso ela não tenha rodado.
--
-- ⚠️ OBRIGATÓRIA ANTES DE LIBERAR A ESCOLHA DE MOEDA (Fase 6 do plano).
--
-- Idempotente.
-- =============================================================================

alter table public.grupos
  add column if not exists moeda_base text not null default 'BRL';

create or replace function public.wallets_moeda_padrao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.moeda is null or btrim(new.moeda) = '' then
    begin
      select nullif(btrim(g.moeda_base), '')
        into new.moeda
        from public.grupos g
       where g.id = new.grupo_id;
    exception when others then
      new.moeda := null;
    end;
    if new.moeda is null then
      new.moeda := 'BRL';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wallets_moeda_padrao on public.wallets;
create trigger trg_wallets_moeda_padrao
  before insert on public.wallets
  for each row execute function public.wallets_moeda_padrao();

alter table public.wallets alter column moeda drop default;

comment on column public.wallets.moeda is
  'Moeda nativa da carteira (ISO 4217). O `saldo` está NESTA moeda. Sem informar, nasce na moeda base do grupo (gatilho trg_wallets_moeda_padrao, migration 169).';

-- Conferência (deve voltar 1 linha, e nenhuma carteira com moeda nula):
--   select tgname from pg_trigger where tgname = 'trg_wallets_moeda_padrao';
--   select count(*) from public.wallets where moeda is null;
