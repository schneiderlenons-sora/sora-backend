# Templates da Cloud API (Meta) — mensagens proativas da Sora

> Mensagens que a Sora **inicia** (welcome, briefing, resumos, recuperação) saem
> normalmente **fora da janela de 24h**. Na Cloud API, fora da janela **só
> template aprovado** é entregue. Este é o catálogo do que criar no **WhatsApp
> Manager → Modelos de mensagem**.
>
> - **Categoria:** `Utilidade` (utility) em todos — barato e aprovação rápida.
> - **Idioma:** `Português (BR)` → código `pt_BR`.
> - Variáveis no corpo são `{{1}}`, `{{2}}`… na ordem em que o código manda os
>   `params`. Botão de URL com sufixo dinâmico usa `{{1}}` no final da URL.
> - O dispatcher fica em `src/services/proativo.js`; a chamada crua em
>   `whatsapp.js → enviarTemplate(phone, name, params, lang, opts)`.

---

## 1. `boas_vindas`  — JÁ LIGADO no código (`welcome.js`)

- **Nome:** `boas_vindas`  ·  **Categoria:** Utilidade  ·  **Idioma:** pt_BR
- **Corpo:**
  ```
  Oi {{1}}! 👋 Sou a Sora, sua assistente financeira no WhatsApp. Seu plano está ativo 🎉

  Me manda seus gastos por *texto*, *áudio* ou *foto* que eu organizo tudo. Alguns exemplos:
  • _gastei 50 no mercado_
  • _saldo_ — vê o saldo das suas contas
  • _resumo_ — receitas, gastos e categorias do mês

  Pra ver tudo que sei fazer, digite *ajuda* a qualquer momento. 🙌
  ```
- **Botão:** tipo **URL dinâmica** · texto `Abrir painel` ·
  URL base `https://forsora.com/` + `{{1}}`  (o código manda `dashboard` ou `onboarding`).
- **Params do código:** body `[primeiroNome]`, `opts.urlButtonParam = 'dashboard'|'onboarding'`.
- **Exemplos que a Meta pede:** corpo `{{1}}` = `Lenon` · botão `{{1}}` = `dashboard`.
- **Formatação:** no corpo, `*negrito*` e `_itálico_` funcionam no template (igual WhatsApp).

---

## 2. `resumo_semanal`  — a ligar (`resumoFinanceiro.js`)

- **Nome:** `resumo_semanal` · Utilidade · pt_BR
- **Corpo (sugestão):**
  ```
  Oi {{1}}! 📊 Seu resumo da semana: você gastou {{2}} e recebeu {{3}}.
  Toque pra ver o detalhamento completo no painel.
  ```
- **Botão:** URL `Ver resumo` → `https://forsora.com/dashboard`
- **Params:** `[nome, totalGasto, totalRecebido]`.

## 3. `resumo_mensal`  — a ligar (`resumoFinanceiro.js`)

- **Nome:** `resumo_mensal` · Utilidade · pt_BR
- **Corpo (sugestão):**
  ```
  {{1}}, fechamento de {{2}} ✅ Gastos: {{3}} · Receitas: {{4}} · Saldo: {{5}}.
  Veja seu Wrapped do mês no painel.
  ```
- **Botão:** URL `Ver fechamento` → `https://forsora.com/wrapped`
- **Params:** `[nome, mesNome, gastos, receitas, saldo]`.

## 4. `briefing_matinal`  — a ligar (`jobs/index.js`, JOB 1K)

- **Nome:** `briefing_matinal` · Utilidade · pt_BR
- **Corpo (sugestão):**
  ```
  Bom dia, {{1}}! ☀️ Sua agenda de hoje: {{2}}.
  Abra a agenda pra ver tudo.
  ```
- **Botão:** URL `Abrir agenda` → `https://forsora.com/grow/agenda`
- **Params:** `[nome, resumoDoDia]`.

## 5. `recuperacao_pagamento`  — a ligar (`recuperacaoPagamento.js`)

- **Nome:** `recuperacao_pagamento` · Utilidade · pt_BR
- **Corpo (sugestão):**
  ```
  Oi {{1}}! Seu pagamento na Sora não foi concluído. Finalize pra reativar seu
  plano — cupom SORA15 = 15% off, válido por 24h.
  ```
- **Botão:** URL `Finalizar agora` → `https://forsora.com/login`
- **Params:** `[nome]`.

---

## Como criar (passo a passo na Meta)

1. **WhatsApp Manager** → **Modelos de mensagem** → **Criar modelo**.
2. Categoria **Utilidade**, idioma **Português (BR)**.
3. Cole o **Corpo**, adicione as **variáveis** `{{1}}…` e, onde indicado, o
   **botão de URL** (estático ou dinâmico).
4. Em variáveis, a Meta pede um **exemplo** por variável (ex.: `{{1}}` = "Lenon").
5. **Enviar pra análise.** Aprovação costuma levar de minutos a ~1 dia.
6. Quando aprovado, o código usa automaticamente (basta `WHATSAPP_PROVIDER=meta`).

> Comece pelo **`boas_vindas`** (já está ligado no código). Os outros 4 eu ligo
> nos respectivos arquivos quando você confirmar que vai criá-los — aí alinho os
> `params` exatamente com o que for aprovado.
