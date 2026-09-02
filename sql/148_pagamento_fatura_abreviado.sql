-- =============================================================================
-- 148 — Pagamento de fatura escrito ABREVIADO ("PAGTO", "PGTO")
--
-- Continuação direta da 127. Lá a lista de frases exigia a palavra inteira
-- "pagamento" — e vários bancos abreviam. O crédito então não era reconhecido
-- como quitação: caía em `creditoAjuste`, virava categoria Reembolso e passava
-- a ABATER a fatura, que é o oposto do certo (o pagamento já abate via
-- `pagamentos_fatura`; contar nos dois lugares tira o valor em dobro).
--
-- MEDIDO ANTES DE ESCREVER — 145 créditos em carteira de cartão na base. A
-- regra atual pega 63; com as abreviações passa a pegar 75. As 12 que entram,
-- somando R$ 57.566,13, e a prova de que são quitação (o valor BATE no centavo
-- com o total de uma fatura publicada pelo banco):
--   · "PAGTO DEBITO AUTOMATICO"      (Banco Inter) ....... 5x
--   · "PAGTO. POR DEB EM C/C"        (Bradesco, Visa) .... 3x, até R$ 21.707,68
--   · "PAGTO ANTECIPADO PIX"         (Bradesco) .......... 2x
--   · "PGTO.BOLETO REGISTRADO"       (Caixa) ............. 2x
--
-- Nove batem com um total publicado. As outras três são pagamentos PARCIAIS —
-- por definição não batem com um total, e a doc da Celcoin descreve o caso:
-- "pagamentos avulsos feitos antes do fechamento (ex.: para liberação de
-- limite)".
--
-- Cartões afetados: Banco Inter Prime, Banco Inter Prime Black, VISA INFINITE
-- PRIME, CAIXA - Platinum, Bradesco Aeternum Black — 4 clientes distintos.
--
-- ⚠️ O QUE NÃO PODE ENTRAR: "PAGAMENTO CASHBACK TAG" tem a palavra "pagamento"
-- e NÃO é quitação — é consumo que voltou e tem de continuar ABATENDO. Por isso
-- a lista segue sendo de FRASES INTEIRAS, com o cashback barrado antes de tudo.
-- Conferido também que estorno, "Crédito de SHEIN" e crédito da Uber ficam de
-- fora.
--
-- ⚠️ Só crédito (`tipo = 'Recebimento'`), só linha de Open Finance
-- (`of_tx_id is not null`) e só em carteira de Crédito. Num cartão, um crédito
-- com essa descrição só pode ser quitação — cartão não recebe salário. Em conta
-- de DÉBITO a mesma frase segue sendo o que era.
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
        t.observacao ilike '%pagto%debito automatico%'
     or t.observacao ilike '%pgto%debito automatico%'
     or t.observacao ilike '%pagto%por deb%'
     or t.observacao ilike '%pgto%por deb%'
     or t.observacao ilike '%pagto%antecipado%'
     or t.observacao ilike '%pgto%antecipado%'
     or t.observacao ilike '%pagto%boleto registrado%'
     or t.observacao ilike '%pgto%boleto registrado%'
   );

-- Confere o resultado (deve devolver 0 linhas depois do update acima):
--
--   select t.data, t.valor, t.observacao, t.categoria, w.nome
--     from public.transacoes t
--     join public.wallets w
--       on w.grupo_id = t.grupo_id and lower(w.nome) = lower(t.carteira_nome)
--    where w.tipo = 'Crédito' and t.tipo = 'Recebimento'
--      and t.of_tx_id is not null and t.categoria <> 'Fatura'
--      and t.observacao not ilike '%cashback%'
--      and (t.observacao ilike '%pagto%debito automatico%'
--        or t.observacao ilike '%pgto%debito automatico%'
--        or t.observacao ilike '%pagto%por deb%'
--        or t.observacao ilike '%pgto%por deb%'
--        or t.observacao ilike '%pagto%antecipado%'
--        or t.observacao ilike '%pgto%antecipado%'
--        or t.observacao ilike '%pagto%boleto registrado%'
--        or t.observacao ilike '%pgto%boleto registrado%');
