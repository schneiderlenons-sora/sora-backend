-- =====================================================================
-- 076 — Re-categoriza transações JÁ importadas do Open Finance
--
-- Por que precisa: o sincronizar dedupa por `of_tx_id` e só INSERE o que é
-- novo — ele nunca reescreve linha existente (de propósito: senão apagaria a
-- categoria que o usuário corrigiu à mão). Então as regras novas do
-- categorizar.js só valem pra transação futura; o que já entrou com a regra
-- antiga continua errado até rodar este backfill.
--
-- Mexe SÓ em linha vinda do Open Finance (of_tx_id is not null) — nunca em
-- lançamento manual/WhatsApp. Idempotente. Aplicar: Supabase → SQL Editor.
--
-- Pré-requisito: rodar antes a 075 (cria a categoria "💼 Trabalho/Negócio").
-- =====================================================================

-- 1) Anúncios/ferramentas de trabalho → Trabalho/Negócio
--    ("FACEBK *WRG9PX9UG2" e similares vinham em Outros)
update public.transacoes set categoria = 'Trabalho/Negócio'
 where of_tx_id is not null
   and categoria is distinct from 'Fatura cartão'
   and (   observacao ilike '%facebk%'
        or observacao ilike '%facebook%'
        or observacao ilike '%meta plataform%'
        or observacao ilike '%google ads%' );

-- 2) Estorno / devolução / liberação de dinheiro → Transferências
--    (vinham em Pet: a keyword 'racao' casava dentro de "libeRAÇÃO" 🙃)
update public.transacoes set categoria = 'Transferências'
 where of_tx_id is not null
   and categoria is distinct from 'Fatura cartão'
   and (   observacao ilike '%venda cancelada%'
        or observacao ilike '%liberação de dinheiro%'
        or observacao ilike '%liberacao de dinheiro%'
        or observacao ilike '%estorno%'
        or observacao ilike '%devolução%'
        or observacao ilike '%devolucao%'
        or observacao ilike '%reembolso%'
        or observacao ilike '%chargeback%' );

-- 3) Assinatura da Sora → Assinaturas (vinha em Encomendas)
update public.transacoes set categoria = 'Assinaturas'
 where of_tx_id is not null
   and (   observacao ilike '%ec*sora%'
        or observacao ilike '%forsora%' );

-- =====================================================================
-- Verificação (deve sair Trabalho/Negócio, Transferências e Assinaturas):
--   select categoria, observacao, valor
--     from public.transacoes
--    where of_tx_id is not null
--      and (observacao ilike '%facebk%' or observacao ilike '%libera%'
--           or observacao ilike '%ec*sora%')
--    order by data desc;
-- =====================================================================
