-- =====================================================================
-- 141 — limpa os "pendentes" que nunca foram pendentes
--
-- Dois relatos do mesmo usuário, duas causas diferentes:
--
-- ── A) PARCELA DE CARTÃO COM DATA PASSADA ────────────────────────────
-- `normalizeTxCartao` grava `pago: !(data > hoje)` — parcela ainda não cobrada
-- nasce NÃO paga, pra contar como prevista. Correto NO DIA em que foi escrita.
-- Só que o sync NUNCA REESCREVE linha existente (é de propósito: protege a
-- categoria corrigida à mão), então quando a data chega e passa, o `pago=false`
-- fica lá PARA SEMPRE. A parcela vira um falso pendente eterno.
--
-- Relato: "a despesa da Chinoca já foi descontada da minha fatura, é compra
-- parcelada, não tem nada pendente nisso".
--
-- MEDIDO na base: 1.000 transações com `pago=false`, das quais **969 são de
-- cartão de crédito**; 204 já passaram da data, somando R$ 21.433,88 de falso
-- pendente. Não é caso isolado — é quase toda a lista.
--
-- ⚠️ ISTO NÃO MEXE NA FATURA. O valor da fatura sai da soma do CICLO
-- (services/valorFatura.js), que não olha `pago` — quem decide quanto falta é
-- `pagamentos_fatura`. Aqui só se corrige o rótulo da linha.
--
-- ── B) "[Previsto]" DE RECORRÊNCIA MARCADA COMO "NÃO LANÇAR" ─────────
-- O modo `nao_lancar` existe pra quem tem Open Finance: a Sora não cria
-- transação nenhuma, o banco traz a cobrança real. O cron respeita isso HOJE,
-- mas linhas criadas ANTES de o usuário escolher o modo ficaram órfãs.
--
-- Relato: "eu informei nos previstos para não lançar, pois viria do Open
-- Finance, inclusive já recebi há muito tempo".
--
-- Medido: 31 recorrências em `nao_lancar`, 42 transações `[Previsto]` na base,
-- 1 órfã (R$ 200,00).
--
-- ⚠️ ELA JÁ TINHA SIDO MARCADA COMO PAGA na tela, e o PUT reconcilia o saldo:
-- marcar um Recebimento como pago soma o valor na carteira. Por isso a limpeza
-- DESFAZ o efeito no saldo antes de apagar a linha — apagar sem desfazer
-- deixaria a conta R$ 200 acima do app do banco, que foi exatamente a
-- divergência relatada.
--
-- Idempotente.
-- =====================================================================

-- ── A) parcela de cartão com data passada volta a ser "paga" ──────────
update public.transacoes t
   set pago = true
  from public.wallets w
 where w.grupo_id = t.grupo_id
   and w.tipo = 'Crédito'
   and lower(btrim(w.nome)) = lower(btrim(t.carteira_nome))
   and t.pago = false
   and t.data::date <= (now() at time zone 'America/Sao_Paulo')::date;

-- ── B) desfaz o saldo das [Previsto] órfãs que foram marcadas como pagas ──
-- Recebimento pago somou na carteira; Gasto pago subtraiu. Desfaz na direção
-- oposta, e SÓ pras linhas que serão apagadas logo abaixo.
with orfas as (
  select t.id, t.grupo_id, t.carteira_nome, t.valor, t.tipo
    from public.transacoes t
    join public.recorrencias r
      on r.grupo_id = t.grupo_id
     and r.modo_lancamento = 'nao_lancar'
     and t.observacao = '[Previsto] ' || r.descricao
   where t.pago = true
),
ajuste as (
  select o.grupo_id, o.carteira_nome,
         sum(case when o.tipo = 'Gasto' then o.valor else -o.valor end) as delta
    from orfas o group by 1, 2
)
update public.wallets w
   set saldo = coalesce(w.saldo, 0) + a.delta
  from ajuste a
 where w.grupo_id = a.grupo_id
   and lower(btrim(w.nome)) = lower(btrim(a.carteira_nome));

-- ── B2) apaga as órfãs (pagas ou não) ─────────────────────────────────
delete from public.transacoes t
 using public.recorrencias r
 where r.grupo_id = t.grupo_id
   and r.modo_lancamento = 'nao_lancar'
   and t.observacao = '[Previsto] ' || r.descricao;

-- ── Conferência (rodar solto) ─────────────────────────────────────────
-- select count(*) as falsos_pendentes_restantes
--   from public.transacoes t join public.wallets w
--     on w.grupo_id = t.grupo_id and w.tipo = 'Crédito'
--    and lower(btrim(w.nome)) = lower(btrim(t.carteira_nome))
--  where t.pago = false and t.data::date <= current_date;
-- Esperado: 0.
