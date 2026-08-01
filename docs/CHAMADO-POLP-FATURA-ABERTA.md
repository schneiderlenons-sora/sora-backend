# Chamado para o suporte da Polp — fatura em aberto do cartão

> Rascunho pronto pra enviar. Os dados são de uma conta de teste nossa (com
> consentimento do titular). Se preferir não expor descrição de compra, corte a
> seção 2 e deixe só os IDs — os três primeiros pontos se sustentam sozinhos.
>
> Medido em **01/08/2026**, Nubank, consentimento
> `019fbd54-2b57-72bf-843b-453eef45596a`, cartão
> `019fbd54-b6e5-72b6-8e49-6ac7e3bc9835`.

---

## Resumo em uma linha

**Não encontramos, na API, nenhum campo (nem combinação de campos) que
corresponda ao valor da fatura EM ABERTO do cartão.** O app do banco mostrava
**R$ 3.423,57** e o dado mais próximo que a API entrega é o limite usado,
**R$ 4.061,99** — R$ 638,42 acima.

---

## 1. `List Bills` não retorna a fatura em aberto

O endpoint devolve **12 faturas, todas FECHADAS e quitadas**. A mais recente:

| campo | valor |
|---|---|
| `id` | `019fbd54-c558-7123-a99f-d0683132b427` |
| `bill_closing_date` | 2026-07-07 |
| `due_date` | 2026-07-14 |
| `bill_total_amount` | 3143.7506 |
| `payments` (soma) | 3143.75 |

O cartão fecha dia 7 e vence dia 14. Na data da consulta (01/08) existia uma
fatura **aberta**, com fechamento em 07/08 e vencimento em 14/08 — e ela **não
aparece na listagem**.

**Perguntas:**
1. A fatura em aberto é exposta em algum lugar da API? Se sim, em qual endpoint
   ou sob qual condição/parâmetro?
2. Se ela só é publicada após o fechamento: qual é a fonte recomendada pelo
   provedor para exibir o valor parcial da fatura corrente?

---

## 2. `parcelamentos` vem DUPLICADO, com `paidInstallments` inconsistente

O mesmo parcelamento aparece **várias vezes**, com valores de parcela diferindo
em centavos e `paidInstallments` diferentes. Exemplos literais da resposta:

```json
{ "description": "MERCADOLIVRE*MERCADOL", "amount": -52.20, "totalInstallments": 5, "paidInstallments": 3 }
{ "description": "Mercadolivre*Mercadol", "amount": -52.23, "totalInstallments": 5, "paidInstallments": 1 }
{ "description": "Mercadolivre*Mercadol", "amount": -52.19, "totalInstallments": 5, "paidInstallments": 5 }
```

O mesmo padrão se repete em pelo menos mais seis compras
(`Amazonmktplc*Drogariaa` 3 e 1 pagas · `Amazonmktplc*Uptechdob` 2 e 1 ·
`Shein *Giovani Alves` 2 e 1 · `SHEIN *BELO DIAMANTE` 2 e 1 ·
`Shein *Thairanne de M` 4 e 1 · `Amazon Marketplace Cc` duas linhas com 1).

Consequência prática: somando as parcelas restantes obtemos **R$ 2.887,67**;
descontando a parcela da fatura corrente, **R$ 1.159,49**. O valor que
precisaríamos explicar é **R$ 638,42**. Nenhuma leitura fecha — ou seja, **o
endpoint não é utilizável para calcular parcelas a vencer**.

**Perguntas:**
3. As entradas duplicadas são o mesmo parcelamento repetido ou compras
   distintas? Se forem a mesma, qual delas tem o `paidInstallments` correto?
4. Há alguma chave estável para deduplicar (id do parcelamento, id da compra
   original)?

---

## 3. Parcela vem com a data da COMPRA, sem indicar a fatura de cobrança

Em `credit_card.transactions`, cada parcela chega com
`transaction_date_time` = data da **compra**, e as transações do ciclo aberto
vêm com **`bill_id` nulo** (40 de 170 registros na consulta).

Com isso não há como saber **em qual fatura cada parcela será cobrada** — nem
por data (todas caem no mês da compra), nem por vínculo (não há `bill_id`).

**Perguntas:**
5. Existe campo que identifique a fatura/competência de cobrança da parcela
   (algo como `bill_post_date`, número da parcela, ou o `bill_id` futuro)?
6. O `bill_id` só é preenchido depois do fechamento da fatura? Isso é
   comportamento do provedor ou do emissor?

---

## 4. `limits[]` sem `LIMITE_CREDITO_TOTAL` e com base de cálculo ambígua

A resposta traz **duas linhas, ambas** `LIMITE_CREDITO_MODALIDADE_OPERACAO` —
nenhuma `LIMITE_CREDITO_TOTAL`:

```json
{ "identification_number": "0425", "line_name_additional_info": "Limite Pix no Crédito",
  "limit_amount": "313.1041", "used_amount": "313.10", "available_amount": "0.00" }

{ "identification_number": "3456", "line_name_additional_info": "Limite saque nacional e saque internacional",
  "limit_amount": "5063.1041", "used_amount": "4061.99", "available_amount": "688.0113",
  "customized_limit_amount": "4750.0000" }
```

Dois pontos:

- O **limite total do cartão** (R$ 5.063,10, que confere com o app) está sob uma
  linha rotulada **"saque nacional e internacional"**, o que não corresponde à
  semântica do campo.
- O `used_amount` (4.061,99) bate com **`customized_limit_amount` − available**
  (4750,00 − 688,01), e **não** com `limit_amount` − available
  (5063,10 − 688,01 = 4.375,09).

**Perguntas:**
7. Para esse emissor, qual linha deve ser lida como limite total do cartão?
8. O `used_amount` é sempre calculado sobre o `customized_limit_amount` quando
   ele existe? Está documentado em algum lugar?
9. O `used_amount` inclui parcelas de faturas futuras? (É a nossa hipótese para
   os R$ 638,42 de diferença, mas gostaríamos da confirmação.)

---

## O que resolveria para nós

Qualquer um destes já fecharia o caso:

- **(a)** expor a fatura em aberto com o total parcial acumulado; ou
- **(b)** preencher o `bill_id` (ou equivalente) nas transações do ciclo corrente
  e nas parcelas futuras; ou
- **(c)** corrigir a duplicação em `parcelamentos` e garantir o
  `paidInstallments`, permitindo calcular as parcelas a vencer.

Hoje exibimos a soma das compras do ciclo com um aviso de que é parcial —
funciona, mas fica abaixo do valor real sempre que há parcelamento.
