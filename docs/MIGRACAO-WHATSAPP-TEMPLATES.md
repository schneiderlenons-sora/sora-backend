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
- **Botão:** tipo **URL estática** · texto `Acessar Painel` ·
  URL `https://forsora.com/dashboard` (a app redireciona pra /onboarding quem ainda não fez).
- **Params do código:** body `[primeiroNome]` apenas (botão estático, sem variável).
- **Exemplo que a Meta pede:** corpo `{{1}}` = `Lenon`.
- **Formatação:** no corpo, `*negrito*` e `_itálico_` funcionam no template (igual WhatsApp).

---

## 2. `resumo_semanal`  — JÁ LIGADO (`jobs/index.js`, JOB 1M)

- **Nome:** `resumo_semanal` · Utilidade · pt_BR
- **Corpo (aprovado):**
  ```
  Oi {{1}}! 📊 Seu resumo da semana: você gastou {{2}} e recebeu {{3}}.
  Toque pra ver o detalhamento completo no painel.
  ```
- **Botão:** URL `Ver resumo` → hoje aponta pra `https://forsora.com/dashboard`.
  ⚠️ **Ação pendente:** o CTA no texto livre (Z-API/dentro da janela) já foi
  trocado pra `/relatorios` (aba de relatórios do painel, sem nova página).
  Editar o botão desse template no WhatsApp Manager pra apontar pra
  `https://forsora.com/relatorios` também — edição só do botão geralmente
  passa sem re-análise, mas confirme no Meta Manager.
- **Params:** `[nome, totalGasto, totalRecebido]`.

## 3. `resumo_mensal`  — JÁ LIGADO (`jobs/index.js`, JOB 1N)

- **Nome:** `resumo_mensal` · Utilidade · pt_BR
- **Corpo (aprovado):**
  ```
  {{1}}, fechamento de {{2}} ✅ Gastos: {{3}} · Receitas: {{4}} · Saldo: {{5}}.
  Veja seu Wrapped do mês no painel.
  ```
- **Botão:** URL `Ver fechamento` → `https://forsora.com/wrapped` (mantém —
  o Wrapped é uma página própria, não mexemos nisso).
- **Params:** `[nome, mesNome, gastos, receitas, saldo]`.

## 2b/3b. `resumo_semanal_v2` / `resumo_mensal_v2` — DRAFT, pendente de aprovação

> Objetivo: levar a **manchete personalizada** (ex. "Semana mais calma",
> "Semana de gastos reduzidos") gerada pela Sora (`gerarInsight` em
> `resumoFinanceiro.js`, com fallback local determinístico) pro corpo do
> template — hoje ela só aparece no texto livre (Z-API/dentro da janela de
> 24h), porque fora da janela a Cloud API só entrega o template aprovado e
> `services/proativo.js` sempre prioriza o template sobre o texto livre quando
> os dois são passados. **Não ligar antes da aprovação:** o código já está
> pronto atrás da flag `RESUMO_TEMPLATE_V2` (`jobs/index.js`, hoje `false` —
> continua mandando o `resumo_semanal`/`resumo_mensal` de sempre). Depois de
> aprovado, é só trocar pra `true`.

- **`resumo_semanal_v2`** · Utilidade · pt_BR
  - **Corpo (sugestão):**
    ```
    {{1}}, sua semana em números 📊 *{{2}}*
    Você gastou {{3}} e recebeu {{4}}. Toque pra ver o detalhamento completo.
    ```
  - **Botão:** URL `Ver resumo` → `https://forsora.com/relatorios`
  - **Params:** `[nome, manchete, totalGasto, totalRecebido]`
    (ex.: `["Marina", "Semana mais calma", "R$ 412,90", "R$ 1.200,00"]`)
  - ⚠️ Variável não pode ficar no início/fim do corpo (regra da Meta) — por
    isso "sua semana em números" abre e "Toque pra ver..." fecha o corpo.

- **`resumo_mensal_v2`** · Utilidade · pt_BR
  - **Corpo (sugestão):**
    ```
    {{1}}, fechamento de {{2}} ✅ *{{3}}*
    Gastos: {{4}} · Receitas: {{5}} · Saldo: {{6}}. Veja o detalhamento no painel.
    ```
  - **Botão:** URL `Ver fechamento` → `https://forsora.com/relatorios`
  - **Params:** `[nome, mesNome, manchete, gastos, receitas, saldo]`
    (ex.: `["Marina", "Julho", "Mês de equilíbrio e saúde", "R$ 2.100,00", "R$ 3.400,00", "R$ 1.300,00"]`)

> A manchete que a IA gera tem até ~60 caracteres (cabe no corpo do template
> sem estourar); o fallback local (sem IA) também respeita esse tamanho.
> Testado ao vivo: `"Semana de gastos reduzidos"`, `"Semana de equilíbrio e
> saúde"`, `"Semana mais calma"`, e comemora quando o resultado foi
> excepcional (100% dos hábitos, treino todo dia) sem precisar de dado novo —
> tudo já calculado em `coletoresGrow.js` + `fallbackInsight`/`gerarInsight`.

## 4. `briefing_matinal`  — a ligar (`jobs/index.js`, JOB 1K)

- **Nome:** `briefing_matinal` · Utilidade · pt_BR
- **Corpo (sugestão):**
  ```
  Bom dia, {{1}}! ☀️ Sua agenda de hoje: {{2}}.
  Abra a agenda pra ver tudo.
  ```
- **Botão:** URL `Abrir agenda` → `https://forsora.com/grow/agenda`
- **Params:** `[nome, resumoDoDia]`.

## 4b. `recorrencias_hoje`  — a aprovar (`jobs/index.js`, JOB 1A)

- **Nome:** `recorrencias_hoje` · Utilidade · pt_BR
- **Cabeçalho:** Imagem (a capa da Sora — o código manda `headerImage` sempre).
- **Corpo (a variável NÃO pode ficar no início/fim → tem texto fixo antes e depois):**
  ```
  Olá! Veja suas recorrências de hoje 👇

  {{1}}

  Pra confirmar um valor, responda *confirmar <nome> <valor>*
  (ex: confirmar vendas 1890,54) — ou edite direto nas suas transações. 😉
  ```
- **Botão:** URL (estática) `Abrir transações` → `https://forsora.com/transacoes`
- **Params:** `[lista]` — o `{{1}}` é SÓ a lista dos itens, ex.:
  `💡 A confirmar o valor: Vendas (estimei R$ 1.700,00), Anúncios Facebook (estimei R$ 1.000,00)`
- **Amostra da variável (o que a Meta pede em "Amostras de variáveis" → {{1}}):**
  `💡 A confirmar o valor: Vendas (estimei R$ 1.700,00), Anúncios Facebook (estimei R$ 1.000,00)`
- **Enquanto não aprovar:** o código tenta esse template e, se falhar, cai no
  `lembretes_gerais` (linha única) automaticamente — não fica sem lembrete.

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

## 6. `atualizacao_sora` — comunicado em massa (`routes/admin.js`)

Aviso de novidade disparado pelo painel admin (**Admin → Comunicados**).

- **Nome:** `atualizacao_sora` · **Categoria: Marketing** · pt_BR · **APROVADO 31/07/2026**
- **Por que Marketing e não Utilidade:** anunciar recurso novo é promocional pela
  política da Meta. Marcar Utilidade num conteúdo desses arrisca reprovação — ou
  reclassificação depois. Custa um pouco mais por mensagem e respeita o "Parar
  promoções" do usuário; é o preço de estar na regra.
- **Corpo:**
  ```
  Eaí, {{1}}! Nova atualização no ar!

  {{2}}

  Qualquer dúvida, é só responder aqui. 💚
  ```
- **Cabeçalho:** **Imagem** (capa do comunicado — `COMUNICADO_CAPA_URL`).
- **Botão:** URL estática · texto `Abrir painel` → `https://www.forsora.com/dashboard`
- **Params do código:** `[primeiroNome, texto]` — os MESMOS do `comunicado_sora`,
  de propósito: trocar de template vira só mudar a env, sem mexer no código.
- **Amostras que a Meta pede:** `{{1}}` = `Lenon` · `{{2}}` = `O Open Finance
  chegou! Conecte seu banco e receba saldo, transações e fatura automaticamente.`
- **APROVADO e EM USO (jul/2026)** — é o padrão do código (`routes/admin.js`),
  não depende de env nenhuma. A `WHATSAPP_TPL_COMUNICADO` fica só como volta
  atrás sem deploy (`=comunicado_sora`) caso a Meta pause o modelo.

### 6.1 Parágrafos: `atualizacao_sora_2` e `atualizacao_sora_3`

**O problema:** a Cloud API **não aceita `\n` dentro de um parâmetro**. Um aviso
comprido chega todo grudado numa linha só — o `{{2}}` vira um bloco ilegível.

**A saída:** uma variável POR PARÁGRAFO, com as quebras no corpo FIXO (que aceita
`\n` à vontade). Como a Meta **também recusa parâmetro vazio**, não dá pra ter um
template de 3 parágrafos e mandar 1 — daí um modelo por quantidade.

O `routes/admin.js` escolhe sozinho pela quantidade de **linhas em branco** que o
admin escreveu, e **cai pro de 1 parágrafo se o modelo não estiver aprovado**
(o comunicado nunca deixa de sair; o painel avisa que achatou).

- **`atualizacao_sora_2`** — mesmo cabeçalho, botão e categoria do `atualizacao_sora`:
  ```
  Eaí, {{1}}! Nova atualização no ar!

  {{2}}

  {{3}}

  Qualquer dúvida, é só responder aqui. 💚
  ```
- **`atualizacao_sora_3`** — idem, com `{{2}}`, `{{3}}` e `{{4}}` separados por
  linha em branco.
- **Amostras:** `{{1}}`=`Lenon` · `{{2}}`=`O Open Finance chegou na Sora! Agora dá
  pra conectar seu banco e receber tudo automático.` · `{{3}}`=`No Básico, 1
  banco. No Premium, até 3 bancos.` · `{{4}}`=`Pra começar, entre em forsora.com
  e abra a aba Open Finance.`
- Texto com **4+ parágrafos**: os excedentes entram juntos no ÚLTIMO — melhor um
  bloco maior no fim do que perder texto ou mandar parâmetro vazio.

> ⚠️ Dentro de um parágrafo a quebra simples continua virando espaço (`oneLine`)
> — é a regra da Cloud API, não escolha nossa. O que separa parágrafo é a **linha
> em branco**.

---

## 7. `limite_atingido` — teto de gasto batido (`services/limites.js`)

Dispara quando o gasto do mês chega no percentual de alerta — do **limite geral**
(`users.meta_mensal`) ou de um **limite por categoria** (`category_limits`).

**Roda nos TRÊS caminhos de entrada de gasto:** WhatsApp (`handlers/transacoes`),
painel (`routes/transacoes` — criação avulsa e import de extrato) e **Open
Finance** (`polpCelcoinSync`, uma vez ao fim do sync). Antes vivia dentro do
handler do zap, e por isso quem lança pelo painel — hoje a maioria — nunca era
avisado. A dedup (`alerta_enviado` / `meta_mensal_alerta_enviado`) garante **um
aviso por limite por mês**, o que é o que segura o sync que importa dezenas de
transações de uma vez.

- **Nome:** `limite_atingido` · **Categoria: UTILIDADE** · pt_BR · **APROVADO 31/07/2026**
- **Por que Utilidade e não Marketing:** é aviso sobre a conta do PRÓPRIO usuário,
  disparado por um gasto que ele acabou de registrar, com números específicos
  dele. Não vende nada. (Se um dia entrar "assine o Premium pra ter mais
  limites", vira Marketing — não misture.)
- **Corpo:**
  ```
  Eaí, {{1}}! Aviso sobre o seu limite de {{2}}.

  Você já usou {{3}} do teto: {{4}} de {{5}}.

  Pra ver onde foi o dinheiro ou mudar o limite, é só abrir o painel. 💚
  ```
- **Cabeçalho:** **nenhum**. É aviso rápido — header de mídia atrasa o envio e
  obrigaria a mandar a capa em toda chamada, sem ganho nenhum aqui.
- **Botão:** URL estática · texto `Abrir painel` → `https://www.forsora.com/categorias`
- **Params do código:** `[primeiroNome, alvo, pct, gasto, teto]`
  - `{{2}}` = `gasto geral` (limite geral) **ou** o nome da categoria **sem
    emoji** (o código tira — emoji em parâmetro não quebra, mas polui a leitura).
  - `{{3}}` = `82%` · `{{4}}` e `{{5}}` = `R$ 652,00` / `R$ 800,00`.
- **Amostras que a Meta pede:** `{{1}}`=`Lenon` · `{{2}}`=`Alimentação` ·
  `{{3}}`=`82%` · `{{4}}`=`R$ 652,00` · `{{5}}`=`R$ 800,00`
- **Env de emergência:** `WHATSAPP_TPL_LIMITE` troca o nome sem deploy.

> ⚠️ **Por que este template era necessário:** o alerta ia por texto livre. Quem
> lançou o gasto está dentro da janela de 24h e recebia normal — mas em **gestão
> compartilhada** os outros membros estão FORA da janela, e pra eles a mensagem
> falhava calada. Alerta de limite que chega só pra metade do grupo é pior que
> não ter alerta.

> ⚠️ O `R$` dos parâmetros é montado à mão (`brlTpl`): `Intl` com
> `style: 'currency'` insere um espaço **não separável** (U+00A0), e caractere
> invisível em parâmetro de template é problema que só aparece em produção.

---

## Como criar (passo a passo na Meta)

1. **WhatsApp Manager** → **Modelos de mensagem** → **Criar modelo**.
2. Categoria **Utilidade** (exceto o nº 6, que é **Marketing**), idioma
   **Português (BR)**.
3. Cole o **Corpo**, adicione as **variáveis** `{{1}}…` e, onde indicado, o
   **botão de URL** (estático ou dinâmico).
4. Em variáveis, a Meta pede um **exemplo** por variável (ex.: `{{1}}` = "Lenon").
5. **Enviar pra análise.** Aprovação costuma levar de minutos a ~1 dia.
6. Quando aprovado, o código usa automaticamente (basta `WHATSAPP_PROVIDER=meta`).

> Comece pelo **`boas_vindas`** (já está ligado no código). Os outros 4 eu ligo
> nos respectivos arquivos quando você confirmar que vai criá-los — aí alinho os
> `params` exatamente com o que for aprovado.
