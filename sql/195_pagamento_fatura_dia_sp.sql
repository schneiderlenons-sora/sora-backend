-- 195 — data do pagamento de fatura no dia de SÃO PAULO, não no de UTC.
--
-- `registrarPagamentosDoOF` gravava `String(t.data).slice(0, 10)` — o dia em
-- UTC. Pagamento entre 21h e meia-noite (Brasil) caía no DIA SEGUINTE e, no
-- dia do fechamento, passava pro lado de "depois do fechamento". Caso real:
-- pagamento às 21h06 de 08/11 gravado como 09/11 tirava R$ 500 do abatimento
-- da fatura do dono (nov/2026). Medido: 60 linhas em 27 cartões.
--
-- Mesma regra de lib/data-br.ts: meia-noite UTC = data pura (fica); qualquer
-- outro horário = instante real (converte pro fuso). Só mexe em `data`.
-- Idempotente.
update public.pagamentos_fatura pf
   set data = case
                when (t.data at time zone 'UTC')::time = '00:00:00'
                  then (t.data at time zone 'UTC')::date
                else (t.data at time zone 'America/Sao_Paulo')::date
              end
  from public.transacoes t
 where t.id = pf.transacao_id
   and pf.data is distinct from case
                when (t.data at time zone 'UTC')::time = '00:00:00'
                  then (t.data at time zone 'UTC')::date
                else (t.data at time zone 'America/Sao_Paulo')::date
              end;
