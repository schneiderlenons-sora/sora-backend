-- =============================================================================
-- 177 — Lembrete DIÁRIO de tarefas em aberto (opt-in), no WhatsApp.
--
-- Pedido do cliente que relatou não receber avisos (01/10/2026): "duas
-- condições seriam interessantes: uma com lembrete diário e outra quando o
-- prazo estiver chegando. Mas essa última você disse que é parecido com os
-- compromissos — então se já existir essa possibilidade dentro dos
-- compromissos eu posso usar essa função para tarefas".
--
-- Ou seja: a segunda ele resolve com compromisso. O que faltava era o diário —
-- até aqui NENHUM cron tocava a tabela `tarefas`.
--
-- Espelha exatamente as colunas de hábitos (`habito_lembrete_*`, migration
-- 031): mesmo opt-in, mesmo horário local, mesma dedup por data. Copiar o
-- padrão que já roda em produção evita inventar um terceiro jeito de agendar
-- aviso.
--
-- ⚠️ NASCE DESLIGADO. Ninguém passa a receber nada sem ligar na aba Tarefas.
--
-- ⚠️ SEM ELA NADA QUEBRA: o JOB 1Q lê estas colunas dentro de try/catch e,
-- no erro, simplesmente não faz nada — nunca derruba os outros crons do mesmo
-- processo (a lição do `getUser` do Grow).
-- =============================================================================

alter table public.users
  add column if not exists tarefa_lembrete_ativo   boolean     not null default false,
  add column if not exists tarefa_lembrete_horario text,
  add column if not exists tarefa_lembrete_ultimo  text;

comment on column public.users.tarefa_lembrete_ativo is
  'Recebe no WhatsApp, uma vez por dia, a lista de tarefas em aberto. Opt-in.';
comment on column public.users.tarefa_lembrete_horario is
  'HH:MM no fuso de São Paulo. O cron roda a cada 15 min e dispara a partir desse horário.';
comment on column public.users.tarefa_lembrete_ultimo is
  'YYYY-MM-DD do último envio — dedup à prova de restart, igual aos hábitos.';
