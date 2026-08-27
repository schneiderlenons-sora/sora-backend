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
-- ⚠️⚠️ ERRO QUE ESTA MIGRATION JÁ COMETEU — NÃO REPETIR ⚠️⚠️
--
-- A primeira versão daqui "desfazia" o saldo: como marcar um Recebimento como
-- pago SOMA o valor na carteira (o PUT reconcilia), eu subtraí de volta antes
-- de apagar a linha. Parecia certo e estava ERRADO.
--
-- A carteira era do OPEN FINANCE. O saldo dela vem do BANCO e é sobrescrito a
-- cada sync — o +200 do clique acidental já tinha sido lavado horas antes. Ou
-- seja, subtraí 200 de um saldo que já estava CORRETO, e a conta do usuário
-- passou a mostrar R$ 2.888,41 contra R$ 3.088,41 no app do banco. O bloco foi
-- removido e o saldo, devolvido à mão.
--
-- REGRA QUE FICA: **nunca ajustar `wallets.saldo` de carteira com
-- `of_conta_id`**. Ali o banco é a fonte da verdade; qualquer correção nossa
-- ou é apagada no próximo sync (inofensiva) ou cria divergência (foi o caso).
-- Corrigir transação nunca deve implicar corrigir saldo de conta conectada.
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

-- ── B) apaga as órfãs (pagas ou não) ──────────────────────────────────
--
-- ⚠️ SEM MEXER NO SALDO. Ver o aviso no cabeçalho: a versão anterior tentava
-- "desfazer" o efeito da baixa acidental e acabou tirando R$ 200 de uma conta
-- de Open Finance cujo saldo já estava certo. Se a conta é conectada, o
-- próximo sync já resolve; se é manual, a diferença é de centavos e mexer
-- automaticamente no saldo de alguém é risco maior que o erro.
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
