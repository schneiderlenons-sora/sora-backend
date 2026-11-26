-- 204 — Compromisso de MAIS DE UM DIA (Agenda do Grow).
--
-- Pedido de cliente (nov/2026): um evento de dois dias seguidos (27 e 28/11,
-- dia todo) teve de ser cadastrado duas vezes. Agora o compromisso tem uma
-- data de FIM opcional: aparece em cada dia da Agenda ("dia 1 de 2") e o
-- lembrete sai antes do PRIMEIRO dia.
--
-- `data` continua sendo o início (é por ela que o lembrete, o Planejamento
-- Semanal e tudo o que já existia funcionam). `data_fim` nulo = um dia só,
-- exatamente como antes.
--
-- Sem esta migration: tudo funciona como antes; só marcar "até" responde que
-- ainda está sendo liberado. Rodar de novo é seguro.

alter table public.compromissos
  add column if not exists data_fim date;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'compromissos_data_fim_check'
  ) then
    alter table public.compromissos
      add constraint compromissos_data_fim_check
      check (data_fim is null or data_fim > data);
  end if;
end $$;
