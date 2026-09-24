-- =====================================================================
-- 172 — Reabre dívidas marcadas como QUITADA com parcelas faltando
--
-- Relato de cliente (set/2026): "quitei uma parcela sem querer e reabri ela
-- diminuindo uma parcela. Mas ainda assim ela ficou como Quitada". Medido na
-- conta dele: IPVA com `status='quitada'` e `parcelas_pagas` 2 de 3.
--
-- CAUSA (corrigida no código, `PUT /api/dividas/:id`): o POST sempre
-- recalculou o status a partir das parcelas; o PUT NUNCA recalculou. E o
-- `statusDeAtraso`, que o PUT já chamava, só anda entre 'ativa' e 'em_atraso'
-- e devolve 'quitada' intacta de propósito. Não existia caminho nenhum que
-- reabrisse uma dívida quitada por engano.
--
-- ⚠️ O CÓDIGO SOZINHO NÃO CONSERTA O PASSADO: quem já editou e ficou com a
-- linha presa só sairia desse estado editando as parcelas DE NOVO. Esta
-- migration corrige as que já estão gravadas.
--
-- Medido em 24/09/2026, antes de rodar: 3 linhas de 212.
--   Curso                     2/3    · sem data de quitação
--   IPVA                      2/3    · quitada em 2026-09-19
--   Antecipação do saque ani  2/286  · quitada em 2025-07-01
--
-- ⚠️ `parcelas_total > 0` é o que protege o resto da base. Dívida SEM parcelas
-- é quitada pelo botão "quitar tudo" e está corretamente quitada — sem esta
-- condição a migration desquitaria todas elas.
--
-- ⚠️ `of_id is null`: em dívida do Open Finance o status vem do banco, e as
-- parcelas pagas podem estar desatualizadas entre um sync e outro. Reabrir
-- uma delas aqui seria sobrescrever o emissor com dado nosso mais velho.
--
-- ⚠️ Só desce de 'quitada' pra 'ativa'. NÃO faz o contrário (marcar como
-- quitada quem tem todas as parcelas pagas): isso mexeria em linha que
-- ninguém reclamou, e o cron de atraso é quem manda no status das ativas.
-- Idempotente.
-- =====================================================================

update public.dividas
   set status        = 'ativa',
       -- Sai junto: "Quitada em <data>" numa dívida em aberto é o próprio
       -- texto que o cliente viu no card e não batia com as parcelas.
       data_quitacao = null,
       updated_at    = now()
 where status = 'quitada'
   and of_id is null
   and parcelas_total is not null
   and parcelas_total > 0
   and coalesce(parcelas_pagas, 0) < parcelas_total;
