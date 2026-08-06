-- =====================================================================
-- 112 — Controle POR CONTA FIXA: o que a Sora faz no vencimento.
--
-- PROBLEMA: quem conectou o Open Finance via duas coisas descrevendo o mesmo
-- gasto — a linha que o cron criava a partir da recorrência e a cobrança que
-- o banco importava. A Sora já lidava com isso convertendo em `[Previsto]` e
-- deixando a cobrança real absorver a previsão (services/reconciliarPrevisto),
-- mas isso acontecia SOZINHO, sem o usuário escolher nem entender.
--
-- Agora é escolha explícita, por conta fixa:
--
--   lancar      → cria a transação como PAGA e movimenta o saldo (padrão de
--                 sempre, pra quem não usa Open Finance);
--   prever      → cria como `[Previsto]` (pendente, não mexe no saldo) e a
--                 cobrança real do banco assume essa linha em vez de duplicar;
--   nao_lancar  → não cria NADA. O card serve só pra somar quanto o usuário
--                 tem de custo fixo. Se `lembrete` estiver ligado, ele ainda
--                 recebe o aviso no WhatsApp.
--
-- `lembrete` também é novo por conta fixa. Antes o aviso era um liga/desliga
-- GERAL do usuário (services/avisos.avisosLigados) — não dava pra querer
-- lembrete do aluguel e não da Netflix.
-- =====================================================================

alter table recorrencias
  add column if not exists modo_lancamento text not null default 'lancar',
  add column if not exists lembrete        boolean not null default true;

-- CHECK em statement separado e tolerante: rodar a migration duas vezes não
-- pode quebrar (o resto do arquivo é idempotente por `if not exists`).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'recorrencias_modo_lancamento_check'
  ) then
    alter table recorrencias add constraint recorrencias_modo_lancamento_check
      check (modo_lancamento in ('lancar', 'prever', 'nao_lancar'));
  end if;
end $$;

-- ── Backfill ────────────────────────────────────────────────────────
-- Conta fixa cuja CARTEIRA está ligada ao Open Finance nasce em 'nao_lancar':
-- o banco já traz a cobrança real, então a Sora não precisa inventar linha
-- nenhuma. Para essas pessoas o card vira painel de custo fixo.
--
-- O casamento é por NOME da carteira (é assim que `recorrencias.carteira`
-- referencia a conta — não há FK), em lower() porque o usuário digita como
-- quer. Mesma comparação que o cron faz com ilike.
update recorrencias r
   set modo_lancamento = 'nao_lancar'
 where r.ativa = true
   and exists (
     select 1 from wallets w
      where w.grupo_id = r.grupo_id
        and lower(w.nome) = lower(coalesce(r.carteira, 'Dinheiro'))
        and w.of_conta_id is not null
   );

comment on column recorrencias.modo_lancamento is
  'lancar = cria paga e move o saldo · prever = cria [Previsto] pra reconciliar com o banco · nao_lancar = não cria nada (só lembrete)';
comment on column recorrencias.lembrete is
  'Avisar no WhatsApp no vencimento. Independe do modo_lancamento.';

-- Conferência:
--   select modo_lancamento, count(*) from recorrencias where ativa group by 1;
