-- =============================================================================
-- 157 — recorrência com FREQUÊNCIA, DURAÇÃO e ANTECEDÊNCIA do lembrete.
--
-- Até aqui toda recorrência era MENSAL e PARA SEMPRE, e o lembrete só sabia
-- avisar no próprio dia. Isso deixava de fora coisas que a pessoa realmente
-- tem: IPVA e seguro (anuais), diarista e feira (semanais), curso em 12x
-- (acaba), e "me avise 3 dias antes" (que é quando ainda dá pra fazer algo).
--
-- ⚠️ TODOS OS DEFAULTS PRESERVAM O COMPORTAMENTO ATUAL, e isso não é detalhe:
-- são 324 recorrências ativas na base, e o cron que as lê LANÇA DINHEIRO
-- sozinho. `frequencia` nasce 'mensal', `data_fim` nasce NULL (= para sempre) e
-- `lembrete_dias` nasce 0 (= avisa no dia). Nenhuma linha existente muda de
-- rumo — a regra nova foi comparada com a antiga em 11.315 combinações de
-- dia × vencimento, com zero divergências (`npm run eval:frequencia`).
-- =============================================================================

alter table public.recorrencias
  add column if not exists frequencia     text     not null default 'mensal',
  add column if not exists dia_semana     smallint,
  add column if not exists mes_vencimento smallint,
  add column if not exists repeticoes     smallint,
  add column if not exists data_inicio    date,
  add column if not exists data_fim       date,
  add column if not exists lembrete_dias  smallint not null default 0;

-- ⚠️ CHECKs com `not valid`: as 324 linhas existentes já satisfazem tudo (os
-- defaults garantem), mas validar a tabela inteira num ALTER trava escrita, e
-- esta tabela é lida pelo cron de hora em hora.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recorrencias_frequencia_check') then
    alter table public.recorrencias
      add constraint recorrencias_frequencia_check
      check (frequencia in ('semanal', 'mensal', 'anual')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'recorrencias_dia_semana_check') then
    alter table public.recorrencias
      add constraint recorrencias_dia_semana_check
      check (dia_semana is null or (dia_semana between 0 and 6)) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'recorrencias_mes_venc_check') then
    alter table public.recorrencias
      add constraint recorrencias_mes_venc_check
      check (mes_vencimento is null or (mes_vencimento between 1 and 12)) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'recorrencias_lembrete_dias_check') then
    alter table public.recorrencias
      add constraint recorrencias_lembrete_dias_check
      check (lembrete_dias between 0 and 30) not valid;
  end if;
end $$;

comment on column public.recorrencias.frequencia is
  'semanal | mensal | anual. Default mensal — o comportamento de sempre.';
comment on column public.recorrencias.dia_semana is
  '0=domingo .. 6=sábado. Só usado quando frequencia = semanal.';
comment on column public.recorrencias.mes_vencimento is
  '1..12. Só usado quando frequencia = anual (o dia vem de dia_vencimento).';
comment on column public.recorrencias.repeticoes is
  'Quantas vezes repete. NULL = para sempre. Guardado para a tela poder reexibir a escolha; quem o cron consulta é data_fim.';
comment on column public.recorrencias.data_fim is
  'Última data em que a recorrência vale. NULL = para sempre. ⚠️ É ESTA a fonte do encerramento, não uma contagem de ocorrências: contador precisaria ser incrementado a cada lançamento e sai de sincronia com um restart, um lançamento manual ou um restore.';
comment on column public.recorrencias.lembrete_dias is
  'Quantos dias ANTES avisar. 0 = no próprio dia (o comportamento de sempre).';

-- O cron deixou de filtrar por `dia_vencimento` no banco (semanal e anual nunca
-- seriam carregadas por aquele filtro) e passou a trazer as ativas do dia.
create index if not exists idx_recorrencias_ativa on public.recorrencias (ativa)
  where ativa = true;
