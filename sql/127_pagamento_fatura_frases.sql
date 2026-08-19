-- =============================================================================
-- 127 — Cada banco tem a SUA frase pro pagamento da fatura
--
-- Continuação direta da `sql/119`, que consertou o "Pagamento recebido" do
-- Nubank. O problema é o mesmo e a causa também: nenhuma dessas frases contém
-- a palavra "fatura", então o detector por descrição
-- (`ehPagamentoFaturaDescricao`) não casa — de propósito, pra "pagamento pix"
-- numa CONTA não virar transferência. A linha caía em `creditoAjuste` →
-- categoria **Reembolso** → e passava a **ABATER** a fatura
-- (services/valorFatura.js: crédito abate, pagamento é neutro).
--
-- Efeito: fatura JÁ PAGA continuava de pé no painel, e o abatimento indevido
-- ainda derrubava a soma do ciclo. No cliente que gerou o relato, as duas
-- faturas de agosto apareciam integralmente em aberto (R$ 2.753,80 +
-- R$ 13.123,09 = R$ 15.876,89) mesmo tendo sido pagas por débito automático.
--
-- MEDIDO ANTES DE ESCREVER — 1.037 créditos em carteira de cartão na base, 36
-- classificados como Reembolso. Destes, 12 são pagamento de fatura, e a prova
-- é que o valor BATE com o total de uma fatura publicada pelo banco:
--   · "PAGAMENTO DEBITO AUTOMATICO" (Itaú) ....... 4x, R$ 30.384,92
--   · "Obrigado pelo pagamento" (Visa Infinite) ... 3x, R$  2.188,71
--   · "Pagamento com saldo" (Itaú Click) .......... 3x, R$    917,77
--   · "PAGAMENTO ON LINE" (Gold) .................. 1x, R$  2.024,90
--   · "Pagamento recebido" (Nubank) ............... 1x, coberto pela 119
--                                                   ─────────────────
--                                                   R$ 35.516,30
--
-- ⚠️ O QUE NÃO PODE ENTRAR: "PAGAMENTO CASHBACK TAG" (R$ 5,00 todo mês num
-- cartão da base) tem a palavra "pagamento" e NÃO é quitação — é cashback, ou
-- seja, consumo que voltou, e tem de continuar ABATENDO a fatura. Foi por isso
-- que esta migration lista FRASES INTEIRAS em vez de procurar "pagamento", e
-- barra o cashback explicitamente. Mesma decisão do código
-- (services/polpCelcoinSync.normalizeTxCartao).
--
-- O código já foi corrigido, mas o sync **nunca reescreve linha existente** —
-- é de propósito, senão apagaria a categoria que o usuário corrigiu à mão.
--
-- Depois desta migration o próximo sync também passa a registrar esses
-- pagamentos em `pagamentos_fatura` (faturaRollover.registrarPagamentosDoOF
-- filtra justamente por categoria Fatura), e as faturas pagas passam a
-- aparecer como quitadas.
--
-- ⚠️ ESCOPO ESTREITO — só mexe em linha que é, ao mesmo tempo:
--   · Recebimento                  (crédito)
--   · com `of_tx_id`               (veio do Open Finance, não foi digitada)
--   · numa carteira tipo 'Crédito' (numa CONTA essas frases podem ser receita
--     de verdade, e marcá-las como transferência as apagaria do dashboard)
--   · com uma das frases abaixo E sem "cashback"
--
-- Idempotente (rodar de novo não muda mais nada).
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

update public.transacoes t
   set categoria     = 'Fatura',
       transferencia = true
  from public.wallets w
 where t.grupo_id      = w.grupo_id
   and lower(t.carteira_nome) = lower(w.nome)
   and w.tipo          = 'Crédito'
   and t.tipo          = 'Recebimento'
   and t.of_tx_id is not null
   and t.categoria    <> 'Fatura'
   and t.observacao not ilike '%cashback%'
   and (
        t.observacao ilike '%pagamento%debito automatico%'
     or t.observacao ilike '%obrigado pelo pagamento%'
     or t.observacao ilike '%pagamento com saldo%'
     or t.observacao ilike '%pagamento on line%'
     or t.observacao ilike '%pagamento online%'
   );

-- Confere o resultado (deve devolver 0 linhas depois do update acima):
--   select t.id, t.data, t.carteira_nome, t.valor, t.categoria, t.observacao
--     from public.transacoes t
--     join public.wallets w
--       on w.grupo_id = t.grupo_id and lower(w.nome) = lower(t.carteira_nome)
--    where w.tipo = 'Crédito' and t.tipo = 'Recebimento'
--      and t.of_tx_id is not null and t.categoria <> 'Fatura'
--      and t.observacao not ilike '%cashback%'
--      and (t.observacao ilike '%pagamento%debito automatico%'
--        or t.observacao ilike '%obrigado pelo pagamento%'
--        or t.observacao ilike '%pagamento com saldo%'
--        or t.observacao ilike '%pagamento on line%'
--        or t.observacao ilike '%pagamento online%');
