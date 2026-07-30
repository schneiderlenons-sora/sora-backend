# Celcoin v2 (Open Finance via Polp) — referência destilada

Lido de `https://polp.com.br/docs/celcoin` (46 páginas, jul/2026). A doc é **SSR**
(o HTML já traz o conteúdo), mas bloqueia bot por user-agent → `curl`/WebFetch dão
**403**; use browser. Este arquivo é o resumo operacional; a doc é a fonte.

> **Não confundir com o trilho Pluggy** (`/docs/pluggy`, API **v1**), que é o que a
> Sora usa hoje em `services/polp.js`. São APIs **diferentes** no mesmo provedor.

---

## 1. Fundamentos

| | Pluggy (v1 — atual) | **Celcoin (v2 — novo)** |
|---|---|---|
| Base URL | `https://api.polp.com.br/api/v1` | `https://api.polp.com.br/api/v2` |
| Auth | `x-api-client` + `x-api-secret` | **idêntico** ✅ |
| Conexão | `POST /integrations` | `POST /consents` |
| Status | `UPDATING`→`WAITING_USER_INPUT`→`UPDATED` | `AWAITING_AUTHORIZATION`→**`AUTHORISED`**→`REJECTED`/`EXPIRED` |
| Paginação | `?page=N` (50/pág) | **cursor**: `?cursor=<next_cursor>` — 15/pág (**500** em transações) |
| Cartão | junto de `accounts` | **entidade separada** `/credit-cards` |
| Investimento | 1 endpoint | **5 tipos** com endpoints próprios |
| Validade do consent | — | **indeterminada** até revogar (`DELETE /consents/{id}`) |

- Erros de acesso: **401** (credencial), **402** (plano inativo / fatura em atraso — vem `payment_url`), **403** (conta pendente de aprovação).
- `GET /institutions` é **público** (sem headers). `institution.credentials[]` diz quais campos mandar no consent (ex.: `cpf`, `cnpj`). Só criar consent se `status = OPERATIONAL`.
- **Rate limit**: `/consents/{id}` = 240 req/min; **todos os `/{recurso}/{id}` (show) = 30 req/min**. Responde 429 com `Retry-After`. A doc insiste: **não faça polling em show — use webhook.**
- Alertas de incidente da plataforma: `GET /api/v1/alerts?provider=celcoin` (**v1**, público).

### ⚠️ Valores monetários são STRING
Todo dinheiro é `{ "amount": "1500.00", "currency": "BRL" }`. **Sempre `parseFloat`** — comparar/somar string dá bug silencioso.

---

## 2. Fluxo de integração

```
GET  /institutions                        → escolher banco (público)
POST /consents { institution_id, cpf, products[] }
     → 201 { id, status, url_to_authenticate, url_to_authenticate_expires_at }
     → redirecionar o usuário pra url_to_authenticate (ATENÇÃO: expira)
     → aguardar status AUTHORISED (por WEBHOOK, não polling)
GET  /consents/{id}/accounts | credit-cards | loans | financings | <investimentos>
GET  /accounts/{id}/transactions   (e os demais /{recurso}/{id}/transactions)
DELETE /consents/{id}                     → revoga (fim do acesso)
```

`products[]` (enum `ConsentProduct`): `ACCOUNT`, `CREDIT_CARD_ACCOUNT`, `LOAN`,
`FINANCING`, `UNARRANGED_ACCOUNT_OVERDRAFT`, `INVOICE_FINANCING`,
`BANK_FIXED_INCOME`, `CREDIT_FIXED_INCOME`, `VARIABLE_INCOME`, `TREASURE_TITLE`,
`FUND`, `EXCHANGE`. **Omitir = pede todos.**

---

## 3. Webhooks — ⚠️ CONTRADIÇÃO NA DOC

**`/webhooks` e `/webhooks/events`** dizem: *"Não há mais `*.created` / `*.updated` /
`*.sync` nem campo `changes`"*. Payload:

```json
{ "event": "accounts.transactions", "resource": "accounts",
  "resource_id": "<uuid>", "query_parameters": "fromCreatedAt=…&toUpdatedAt=…" }
```
Fluxo: recebe evento → **relista com o `query_parameters`** (janela da sync). Eventos:
`consents`, `accounts`, `accounts.transactions`, `credit_cards`,
`credit_cards.transactions`, `bills`, `loans`, `financings`, `<investimento>` e
`<investimento>.transactions`. Empréstimo/financiamento **não** têm `*.transactions`.
`bills` não tem rota direta por consent: **liste os cartões e depois `/credit-cards/{id}/bills`**.

**MAS** a página `/enums` (enum `CelcoinWebhookEvent`) ainda lista
`accounts.created`, `accounts.updated`, `accounts.sync`, `bills.created`, … e as
páginas `*/show` mandam *"aplique o campo `changes` do webhook"*.

→ **Tratar defensivamente:** normalizar o nome do evento removendo sufixo
(`accounts.created` → `accounts`), aceitar payload com e sem `changes`, e nunca
depender de `changes` (se vier, é bônus; a fonte é relistar).

---

## 4. Conta bancária

`GET /consents/{id}/accounts` → `identification`, `balance`, `overdraft_limit`
(**eager loading; podem vir `null` antes da 1ª sync**).

| Campo | Uso na Sora |
|---|---|
| `balance.available_amount` | **saldo da conta** |
| `balance.blocked_amount` | bloqueado |
| `balance.automatically_invested_amount` | rende automático (ex.: Nubank) — **não é saldo livre** |
| `overdraft_limit.overdraft_contracted_limit` | **cheque especial contratado** (temos isso manual — migration 094!) |
| `overdraft_limit.overdraft_used_limit` | cheque especial usado |
| `type` | `CONTA_DEPOSITO_A_VISTA` \| `CONTA_POUPANCA` \| `CONTA_PAGAMENTO_PRE_PAGA` |

**Transações** (`/accounts/{id}/transactions`, 500/pág):
`transaction_amount`, `credit_debit_type` (`CREDITO`/`DEBITO`), `transaction_date_time`,
`type` (`PIX`, `TED`, `BOLETO`, `CARTAO`, `SAQUE`, `RENDIMENTO_APLIC_FINANCEIRA`,
`ENCARGOS_JUROS_CHEQUE_ESPECIAL`, …), `partie_*` (contraparte), `counterparty`, `category_ref`.

⚠️ **`completed_authorised_payment_type`**: `TRANSACAO_EFETIVADA` |
**`LANCAMENTO_FUTURO`** | `TRANSACAO_PROCESSANDO`. Filtrar por isto em vez de
comparar data com hoje (era o nosso workaround da Pluggy).

---

## 5. Cartão de crédito — resolve TUDO que faltava

`GET /consents/{id}/credit-cards` → `identification`, `limits[]`.

- `credit_card_network` = bandeira (`VISA`/`MASTERCARD`/`ELO`/…) → substitui nosso `mapBandeira`.
- `identification.payment_methods[].identification_number` = **últimos 4 dígitos**.
- **`limits[]` é ARRAY** por linha de crédito. Pro limite do cartão, filtrar
  `credit_line_limit_type = 'LIMITE_CREDITO_TOTAL'`; `line_name` distingue
  `CREDITO_A_VISTA` / `CREDITO_PARCELADO` / `SAQUE_*`. Campos: `limit_amount`,
  `used_amount`, `available_amount`.

### 5.1 Fatura (`/credit-cards/{id}/bills`) — o ouro
| Campo | Significado |
|---|---|
| **`bill_total_amount`** | **valor da fatura** — direto do banco |
| **`bill_closing_date`** | **data de FECHAMENTO** (a Pluggy mandava `null`!) |
| **`due_date`** | **data de vencimento** |
| **`bill_minimum_amount`** | pagamento mínimo (nossa coluna da migration 077) |
| `is_instalment` | a fatura foi parcelada (rotativo) |
| `payments[]` | `{amount, paymentDate, valueType, paymentMode}` — **pagamentos já feitos** |
| `finance_charges[]` | juros/multa/IOF por atraso |

→ **A "regra de ouro" `fatura = balance − parcelas a vencer` deixa de ser
necessária no trilho Celcoin.** Ela existia porque a Pluggy não dava a fatura.
Aqui `bill_total_amount` **é** a fatura, e `bill_closing_date`/`due_date` vêm
prontos — não precisa nem do nosso ciclo calculado (que segue valendo pra
cartão MANUAL e pro trilho Pluggy).

### 5.2 Transações do cartão
`brazilian_amount` (**usar este**, em BRL) × `amount` (moeda original).
**`bill_id`** → vincula a transação à fatura exata (fim do cálculo de ciclo pra OF).
`transaction_type` = `PAGAMENTO` | **`PAGAMENTO_FATURA`** | `TARIFA` | `ESTORNO` |
`CASHBACK` | `OPERACOES_CREDITO_CONTRATADAS_CARTAO` → identifica pagamento de fatura
sem regex. `charge_identificator` = parcela atual, `charge_number` = total.
`payee_mcc`, `counterparty.logo_url` (logo do estabelecimento!), `category_ref`.

### 5.3 Parcelamentos (`/credit-cards/{id}/installments`)
`description`, `amount` (por parcela, débito negativo), `totalInstallments`,
**`paidInstallments`** ← a Pluggy **não** dava isso, `occurrences[]` (ids das txs).
Derivado pela Polp (não é recurso OF). ⚠️ `paidInstallments` = parcelas
**encontradas** (`len(occurrences)`), não necessariamente "pagas".

### 5.4 Recorrências / assinaturas (`/credit-cards/{id}/recurrings`)
`description` normalizado, `averageAmount`, `currency` (mantém USD em assinatura
internacional), `periodMonths`, `expectedDay`, `nextExpectedAt`, `regularityScore`
(0-1), `occurrences[]`. Exige ≥3 meses cobrados; exclui parcelamento/tarifa/estorno.
→ Alimenta os **"Previstos do mês"** com muito mais qualidade que
`detectarRecorrencias.js`.

---

## 6. Empréstimo / financiamento → mapeia na tabela `dividas`

`GET /consents/{id}/loans` (e `/financings`) → `contract`, `warranties`,
`scheduled_instalments`, `payments`.

| Celcoin | `dividas` |
|---|---|
| `contract.contract_amount` | `valor_total` |
| `scheduled_instalments.total_number_of_instalments` | `parcelas_total` |
| `scheduled_instalments.paid_instalments` | `parcelas_pagas` |
| `contract.next_instalment_amount` | `valor_parcela` |
| `contract.cet` / `interest_rates[]` | `taxa_juros` (CET anual: `0.29` = 29%) |
| `contract.first_instalment_due_date` | derivar `dia_vencimento` |
| **`payments.contract_outstanding_balance`** | **saldo devedor real** (hoje calculamos `restantes × parcela`) |
| `scheduled_instalments.past_due_instalments` | parcelas **vencidas** → status `em_atraso` |

`amortization_scheduled` = `PRICE`/`SAC`/`SAM`. Financiamento: `product_type` =
`FINANCIAMENTOS` | `_RURAIS` | `_IMOBILIARIOS`.

---

## 7. Investimentos (5 tipos, endpoints próprios)

| Tipo | Endpoint | `investment_type` |
|---|---|---|
| Renda fixa bancária | `/consents/{id}/bank-fixed-incomes` | `CDB`,`RDB`,`LCI`,`LCA` |
| Renda fixa crédito | `…/credit-fixed-incomes` | `DEBENTURES`,`CRI`,`CRA` |
| Fundos | `…/funds` | `anbima_category` |
| Tesouro Direto | `…/treasure-titles` | — |
| Renda variável | `…/variable-incomes` | por `ticker` |

Cada um tem `product` (identificação) + `balance` (posição) — **os dois podem ser
`null` antes da sync** — e `/{recurso}/{id}/transactions`.

- **Posição:** `balance.net_amount` (**líquido — usar pro patrimônio**),
  `gross_amount`, `income_tax` (IR), `financial_transaction_tax` (IOF),
  `blocked_balance`, `quantity`, `updated_unit_price`, `purchase_unit_price`.
  Fundos usam `quota_quantity`/`quota_gross_price_value`; renda variável tem
  `closing_price` e **não** tem `net_amount`.
- **Rentabilidade** (`product.remuneration`): `indexer` + `post_fixed_indexer_percentage`
  + `pre_fixed_rate`. Ex.: `100% CDI + 5%` → `CDI`/`100`/`5`; `Pré 16,76%` →
  `PRE_FIXADO`/`—`/`16.76`. `rate_type` (`LINEAR`/`EXPONENCIAL`) é forma de cálculo,
  **não** indexador.
- `product.due_date` (vencimento), `purchase_date`, `grace_period_date` (carência).
- Movimentações: `type` = `ENTRADA`/`SAIDA` + `transaction_type` (`APLICACAO`,
  `RESGATE`, `VENCIMENTO`, `PAGAMENTO_JUROS`, `AMORTIZACAO`, `COME_COTAS`,
  `DIVIDENDOS`, `JCP`, `ALUGUEIS`, …).

---

## 8. Frequência de sync (igual em todos os planos)

Saldo da conta **14×/dia** · transações da conta **8×/dia** · limites do cartão
**8×/dia** · transações do cartão **8×/dia** · **faturas 1×/dia** · identificação
1× a cada ~8 dias · saldo de investimento 4×/dia (renda variável 1×/dia) ·
parcelas/pagamentos de empréstimo 1×/dia.
Cronograma por consent: `GET /consents/{id}/sync-schedules` (`last_sync_at`, `next_sync_at`).

---

## 9. Extras

- **Taxonomia de categorias** (`GET /categories`, enum `TransactionCategory`):
  ~150 categorias hierárquicas **em português** (`parent_id`), já vindas em
  `category_ref` das transações. Ex.: `FOOD_AND_DRINK_GROCERIES`,
  `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, `TRANSPORTATION_TAXIS_AND_RIDE_SHARES`.
- **`counterparty`** (conta e cartão): `{name, alias, tax_id, website_url, logo_url}`.
  Enriquecido **assíncrono** → **pode vir `null` na 1ª consulta** (não tratar como erro).
- **MCP**: `https://api.polp.com.br/mcp/open-finance-celcoin` (Streamable HTTP,
  mesmas credenciais, **exige plano Pro**), 37 tools em paridade com o REST.
  Não é o caminho do backend — é pra agente de IA consumir.
- **67 enums** em 10 grupos (`/docs/celcoin/enums`).

---

## 9b. Configuração na Sora (dashboard da Polp + Render)

**Env vars (Render → Environment):**
```
POLP_CELCOIN_CLIENT_ID       = client_id do dashboard (provider Celcoin)
POLP_CELCOIN_CLIENT_SECRET   = secret (exibido UMA vez na criação)
POLP_CELCOIN_WEBHOOK_SECRET  = a chave da "Assinatura HMAC-SHA256" (opcional,
                               mas recomendada — ver abaixo)
```
Sem as duas primeiras, o trilho responde 503 e o Pluggy segue normal.

**Webhook** (Dashboard → Webhooks → Novo Endpoint, provider **Celcoin**):
- URL: `https://sora-backend-jqm8.onrender.com/api/webhooks/celcoin`
- Eventos: **marcar todos**. O handler agenda um sync do consentimento inteiro
  com **debounce de 20s**, então a rajada (accounts + accounts.transactions +
  credit_cards + bills…) vira UMA sincronização. Marcar só alguns é o que dá
  risco: os `*.transactions` são os que avisam movimentação nova (8×/dia),
  enquanto os de recurso trazem saldo/limite/fatura/posição.
- **Assinatura HMAC**: ligar. O header é `X-Webhook-Signature` sobre o corpo
  CRU (por isso `express.json({ verify })` guarda `req.rawBody` no app.js).
  `assinaturaConfere()` aceita hex e base64, com ou sem prefixo `sha256=`, e
  compara com `timingSafeEqual`. **Enquanto `POLP_CELCOIN_WEBHOOK_SECRET` não
  estiver definida a validação fica desligada** (aceita tudo) — dá pra ligar a
  chave no dashboard e a env em ordens diferentes sem derrubar nada. Se o
  formato do header for outro, o log do 1º payload rejeitado mostra o que veio.

## 10. Riscos / pontos de atenção

1. **Contradição de webhook** (seção 3) — normalizar nome do evento e não depender de `changes`.
2. **Dinheiro como string** — `parseFloat` sempre.
3. **`null` é normal**: `identification`/`balance`/`product`/`limits`/`counterparty`
   antes da 1ª sync. Nunca tratar como falha.
4. **Show tem 30 req/min** — com N contas isso estoura fácil num sync sequencial.
   Usar as **listagens do consent** (que já trazem tudo por eager loading).
5. **`limits[]` é array** — pegar o item errado dá limite errado no cartão.
6. **`amount` vs `brazilian_amount`** em cartão — usar `brazilian_amount`.
7. **`paidInstallments`** = parcelas encontradas, não pagas.
8. Cursor-based: **não existe `page`**; guardar `next_cursor`.
