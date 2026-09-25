# Plano — Negócios multiusuário (equipe na mesma empresa)

> **Status:** proposto, aguardando aprovação. Nada implementado.
> **Origem:** relato de cliente Platinum (Elivelton, 24/09/2026).
> **Decisão já tomada pelo dono:** cada membro paga o **próprio Platinum**.

---

## 1. O pedido, nas palavras do cliente

> *"Contratei a Sora para utilização dentro da minha empresa, principalmente na
> gestão financeira. A ideia é que diferentes membros do financeiro, **cada um
> pelo seu próprio WhatsApp**, possam acessar a mesma empresa/base, lançar
> despesas, registrar pagamentos, contas a pagar e acompanhar as informações em
> conjunto. […] Estou tentando adicionar minha equipe, porém **só encontrei a
> opção de criar/adicionar outra conta pessoal, o que aparentemente cria um
> acesso separado. Não é isso que preciso.**"*

Ele está certo: hoje isso não existe.

---

## 2. O que foi MEDIDO (não suposto)

### 2.1 A aba Negócios é por USUÁRIO, não por grupo

```
eq('user_id', user.id) em src/routes/negocios.js ......... 28 ocorrências
  empresas ................ 5      custos_negocio ......... 2
  funcionarios_negocio .... 4      contas_negocio ......... 2
  dre_snapshots ........... 4      integracoes ............ 1
  eventos_financeiros ..... 3      insights_negocio ....... 1
  config_negocio .......... 3      conciliacao_negocio .... 1
  lancamentos_negocio ..... 2
```

⚠️ **A coluna `empresas.grupo_id` já EXISTE e já é GRAVADA na criação — e nunca
é lida.** Hoje ela é decorativa.

### 2.2 O WhatsApp também resolve a empresa por usuário

```
src/handlers/vendaNegocio.js:49   .eq('user_id', user.id)
src/handlers/negocios.js:330      .eq('user_id', userId)
```

Ou seja, a mensagem de um funcionário **não acharia empresa nenhuma** — que é
exatamente o coração do pedido dele.

### 2.3 A maior parte do modelo JÁ está pronta para multiusuário

| Tabela | Escopo hoje | Linhas |
|---|---|---|
| `empresas` | `user_id` + `grupo_id` | 32 |
| `lancamentos_negocio` | `empresa_id` + `user_id` | 178 |
| `funcionarios_negocio` | `empresa_id` + `user_id` | 7 |
| `clientes_negocio` | **`empresa_id`** | 21 |
| `produtos_negocio` | **`empresa_id`** | 2 |
| `fornecedores_negocio` | **`empresa_id`** | 1 |
| `compras_negocio` | **`empresa_id`** | 1 |
| `centros_custo` | **`empresa_id`** | 4 |
| `dre_snapshots` | `empresa_id` + `grupo_id` + `user_id` | 51 |

**Sete das nove tabelas já penduram tudo em `empresa_id`.** Isso significa que o
controle de acesso tem **um ponto de estrangulamento**: quem pode ver uma
`empresa`. Mude isso e a aba inteira acompanha.

### 2.4 Raio de impacto da mudança

```
empresas ativas .......................................... 32
⚠️ com grupo_id ≠ grupo_ativo atual do dono ............... 9
grupos com 2+ membros ..................................... 4
empresas que hoje passariam a ser vistas por outro membro . 1
```

⚠️ **As 9 empresas com `grupo_id` desalinhado são a armadilha principal.** Cinco
delas são do próprio cliente do relato: ele criou as empresas quando seu grupo
ativo era outro, e depois trocou. **Trocar `user_id` por `grupo_id` faria essas
9 empresas sumirem dos próprios donos.** A leitura tem de ser UNIÃO, nunca
substituição.

---

## 3. ⚠️ Por que NÃO usar o grupo pessoal (a decisão que define o plano)

O caminho óbvio seria: "a aba Negócios passa a enxergar por `grupo_id`, e o
cliente convida a equipe pro grupo dele". **Isso está errado, e é o ponto mais
importante deste documento.**

Entrar no grupo pessoal dá acesso ao **painel pessoal inteiro** do dono:
transações, contas bancárias, cartões, metas, dívidas, limites, previstos e
relatórios. Para colocar um funcionário do financeiro na empresa, o cliente
teria de **mostrar a ele o próprio dinheiro pessoal**.

Ninguém vai fazer isso. E se fizer, é um vazamento que nós causamos.

> **Regra do plano:** o acesso à empresa é **próprio da empresa**, não herdado do
> grupo pessoal. Gestão compartilhada (casal/família) e equipe de empresa são
> duas coisas diferentes e continuam separadas.

Há um segundo motivo, que o caso dele já demonstra: ele tem **6 empresas**
(IM RIO GRANDE, IM PELOTAS, IM CAMAQUÃ, IM BAGÉ, DISTRIBUIDORES, ANHANGUERA PM).
Com escopo por grupo, quem entra vê **todas**. Um gerente de loja precisa ver a
loja dele, não a rede inteira.

---

## 4. Desenho proposto

### 4.1 Migration — `sql/173_empresa_membros.sql`

```sql
create table if not exists public.empresa_membros (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  user_id     uuid not null references public.users(id)    on delete cascade,
  papel       text not null default 'operador',
  convidado_por uuid references public.users(id),
  created_at  timestamptz not null default now(),
  unique (empresa_id, user_id)
);

alter table public.empresa_membros
  drop constraint if exists empresa_membros_papel_check;
alter table public.empresa_membros
  add constraint empresa_membros_papel_check
  check (papel in ('admin', 'operador', 'leitura'));

-- ⚠️ BACKFILL OBRIGATÓRIO: todo dono vira admin da própria empresa. Sem isto,
-- no instante em que a leitura passar a consultar esta tabela, TODO MUNDO
-- perde a própria empresa.
insert into public.empresa_membros (empresa_id, user_id, papel)
select e.id, e.user_id, 'admin' from public.empresas e
on conflict (empresa_id, user_id) do nothing;

create index if not exists idx_empresa_membros_user on public.empresa_membros (user_id);

-- Convite POR EMPRESA (a tabela `convites` existente é por grupo e continua
-- servindo à gestão compartilhada pessoal — são fluxos diferentes).
create table if not exists public.convites_empresa (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  codigo      text not null unique,
  papel       text not null default 'operador',
  criado_por  uuid references public.users(id),
  expira_em   timestamptz not null,
  usado       boolean not null default false,
  created_at  timestamptz not null default now()
);
```

**Papéis:**

| Papel | Pode |
|---|---|
| `admin` | tudo, inclusive convidar/remover membros e apagar a empresa |
| `operador` | lançar, pagar, dar baixa, cadastrar cliente/produto/fornecedor |
| `leitura` | só ver (DRE, caixa, relatórios) — para contador e sócio investidor |

### 4.2 Fonte única de acesso — `src/services/acessoEmpresa.js`

```js
empresasDoUsuario(userId)        // → [{ id, nome, papel }]
papelNaEmpresa(userId, empresaId) // → 'admin' | 'operador' | 'leitura' | null
exigirEmpresa(papeisAceitos)      // middleware Express
```

⚠️ **A leitura é UNIÃO, nunca substituição** — é o que protege as 9 empresas com
`grupo_id` desalinhado:

```
sou membro em empresa_membros   OU   sou o user_id da empresa (dono histórico)
```

O segundo ramo é a rede de segurança: mesmo que o backfill falhe ou uma linha
nasça sem membro, **o dono nunca perde a própria empresa**.

### 4.3 As 28 trocas

Cada `eq('user_id', user.id)` vira uma consulta ao serviço. Três formas:

1. **`empresas`** (5) → `empresasDoUsuario(userId)`.
2. **Tabelas com `empresa_id`** (`lancamentos_negocio`, `funcionarios_negocio`,
   `dre_snapshots`, `contas_negocio`, `custos_negocio`, `insights_negocio`…) →
   **o filtro por `user_id` simplesmente SAI**; o `empresa_id` já delimita, e a
   permissão foi checada no middleware. ⚠️ Em `lancamentos_negocio` o `user_id`
   deixa de ser filtro e passa a ser **autoria** (quem lançou) — a coluna
   continua gravada, só muda o papel dela.
3. **`config_negocio` / `integracoes` / `conciliacao_negocio`** → passam a ser da
   EMPRESA, não do usuário. ⚠️ `conciliacao_negocio` é a única sem `grupo_id`
   (pegadinha já registrada no CLAUDE.md) e vai precisar de `empresa_id`.

### 4.4 WhatsApp — cada um no seu número

`vendaNegocio.js` e `negocios.js` passam a resolver a empresa por
`empresasDoUsuario(user.id)` em vez de `user_id`.

⚠️ **Com 2+ empresas a Sora tem de PERGUNTAR qual**, e não escolher a primeira.
Hoje o código faz `.order('created_at').limit(1)` — com uma rede de 6 lojas isso
lançaria a venda na loja errada **em silêncio**, que é pior que não lançar.
Reusa `transacoes_pendentes` (o mesmo mecanismo de "de qual conta saiu?"),
**sem migration nova**.

Atalho para quem opera sempre a mesma loja: `empresa_membros.padrao` (boolean) —
ou a frase já nomear ("vendi 3 bolos por 90 na **pelotas**").

### 4.5 Gate de plano — decisão do dono

**Cada membro precisa do próprio Platinum.** `temNegocios()` continua olhando o
plano do PRÓPRIO usuário; nada de herança.

⚠️ **Mas o vazio tem de explicar isso.** Hoje quem não tem o plano vê a aba
sumir ou um paywall genérico. Um funcionário convidado por um Platinum precisa
ler *"você foi convidado para IM PELOTAS; para operar pelo painel e pelo
WhatsApp é preciso um plano Platinum"* — com o convite **guardado**, para ele
entrar direto na empresa assim que assinar. Sem isso, o convite morre no paywall
e o cliente volta a reclamar.

### 4.6 Painel

- **Configurações da empresa → aba "Equipe"**: lista de membros, papel, convidar
  (link + QR, reusando o que foi corrigido em 25/09), remover.
- **Autoria nas listas**: caixa, contas a pagar e vendas ganham "por <nome>".
  A coluna `user_id` já existe em `lancamentos_negocio` — é leitura, não
  migration.
- **Seletor de empresa** já existe (`SeletorEmpresa`) e passa a listar as
  empresas em que a pessoa é membro.

---

## 5. Fases

| # | Entrega | Risco | Estado |
|---|---|---|---|
| 1 | Migration 173 + `acessoEmpresa.js` + backfill | baixo (nada lê ainda) | ✅ feita |
| 2 | Escopo por empresa nas rotas + papéis + WhatsApp | **alto — é controle de acesso** | ✅ feita |
| 3 | Aba "Equipe" no painel + convite por empresa | médio | pendente |
| 4 | WhatsApp: perguntar qual empresa quando houver dúvida | médio | parcial (ver abaixo) |
| 5 | Autoria nas listas | baixo | pendente |

**Cada fase vai para produção separada**, e a 2 só depois da 1 estar rodando.

### O que a fase 2 entregou (25/09/2026)

`empresaDoUsuario` virou uma casca sobre `acessoEmpresa.podeNaEmpresa`, e com
isso os 9 pontos que já passavam por ela foram convertidos de uma vez. O que
precisou de mão foram os **11 `.eq('user_id', user.id)` de update/delete por
id** — eles são o que travava o multiusuário na prática: o gerente não
conseguia dar baixa numa conta lançada pelo dono, e o erro saía como
"não encontrado", sem explicar nada. Hoje quem responde é `linhaAlcancada`.

⚠️ **`routes/negociosOperacao.js` (clientes, produtos, vendas, estoque,
compras, equipe) coube numa mudança só** — ele tem UMA porta (`contexto()`),
enquanto `routes/negocios.js` repetia o escopo em cada rota. O papel mínimo ali
sai do **método HTTP** (GET → `leitura`, resto → `operador`), justamente para
que uma rota criada depois nasça protegida sem ninguém lembrar.

**Papéis aplicados:** `leitura` lê e não escreve · `operador` escreve e não
renomeia a empresa · `admin` renomeia e configura · **arquivar é só do DONO**,
nem do admin convidado (some com o histórico da equipe inteira, sem desfazer).
A 173 foi atualizada para dizer isso — código e doc não podem divergir.

**WhatsApp:** `vendaNegocio` passou a olhar as empresas ALCANÇADAS (antes
`user_id`, o que fazia a mensagem do vendedor convidado voltar como finança
pessoal), e o papel `leitura` fica de fora — o contador vê o DRE, não lança
venda.

⚠️ **Com 2+ lojas e nenhuma padrão, a venda NÃO é recusada** — embora
`empresaAssumida` devolva `null` ali de propósito. Medido: **3 clientes** estão
nessa situação (um com as 6 lojas do relato), e hoje a Sora registra na
primeira. Responder "escolha a principal" quebraria a venda por WhatsApp desses
três, e a tela onde se marca o padrão só chega na fase 3 — regressão que trava
venda é pior que o problema que resolve. Mantém-se a primeira loja, mas o
silêncio acaba: a confirmação **nomeia a loja** em que caiu, então um palpite
errado é visível no mesmo segundo em vez de sujar o caixa por semanas. A fase 4
fecha isso de verdade (aceitar a loja dita na frase e lembrar a escolha).

### Achados fora do plano, corrigidos junto

Ao converter o escopo apareceram **seis rotas sem checagem de dono NENHUMA** —
`auth` só provava que quem chamava estava logado, e qualquer conta apagava a
linha de qualquer outra sabendo o id:

- `DELETE /integracoes/:id` e `POST /integracoes/:id/importar-historico`
- `DELETE /custos/:id`
- `POST /insights/:id/visto` e `/dispensar`
- `DELETE /conciliacao/:id`

Não eram regressão do multiusuário: já estavam em produção. Entraram junto por
serem as mesmas linhas que a fase reescreveu.

E **o `POST /custos` nunca gravou `empresa_id`** — é a origem das 3 linhas
órfãs medidas na base (de 30/07 e 03/09, ou seja, DEPOIS de a 090 rodar: não
foi o backfill que falhou, era o insert). Migration **174** carimba o passado,
**só onde não há dúvida** (dono com uma empresa ativa só); um dos três donos
tem três empresas, e escolher uma seria jogar o custo no DRE errado. A leitura
degrada pro lado de **mostrar**: o `GET /custos` tem ramo explícito para as
órfãs do próprio dono, senão elas sumiriam da tela de quem as lançou.

Junto: `dre-detalhado`, `forecast` e o `snapAnt` do `wrapped` somavam **todas
as empresas do usuário** enquanto o `/dre` ao lado já filtrava por empresa — em
quem tem duas lojas, o detalhamento contradizia o próprio DRE logo acima. E o
upsert de `config_negocio` apontava para `onConflict: 'user_id'`, chave que a
090 §4 substituiu por `empresa_id` (com uma empresa só ninguém sentiu; com
duas, a config da segunda colidiria com a da primeira).

⚠️ **`conciliacao_negocio` FICA por `user_id`, de propósito** — é a única rota
da aba que não virou por empresa. Ela casa evento do negócio com `transacoes`,
que é o extrato **pessoal** de quem conciliou; abrir por empresa entregaria a
conta bancária pessoal do dono ao funcionário do financeiro, que é exatamente
o motivo de a equipe não reusar o grupo pessoal (seção 3).

⚠️ **`agendaFeed` continua por `grupo_id`**, então os lembretes de contas e
folha no briefing do WhatsApp seguem indo só para o grupo do dono. Não é
regressão (o dono recebe como sempre), mas o membro convidado não recebe.
Ligar isso é decisão de produto — começar a mandar mensagem sobre a folha de
pagamento de outra pessoa não pode ser efeito colateral de uma fase de acesso.

---

## 6. Verificação

1. **`npm run eval:acesso-empresa`** (novo): dono sempre enxerga a própria
   empresa mesmo sem linha em `empresa_membros`; `leitura` não grava; membro de
   uma empresa não alcança outra; remover membro corta o acesso na hora.
2. **Teste de regressão medido**: as 32 empresas ativas e seus donos continuam
   vendo exatamente o que viam. ⚠️ Rodar ANTES e DEPOIS, comparando lista por
   lista — as 9 com `grupo_id` desalinhado são o caso que precisa provar que
   não sumiu.
3. **Mutação** no `acessoEmpresa`: inverter o papel, remover o ramo do dono,
   aceitar empresa de outro — todas têm de matar o eval.
4. **IDOR**: com o token do membro A, tentar `empresa_id` do membro B → 403.

---

## 7. Fora de escopo (de propósito)

- **Herança de plano.** Decisão do dono: cada membro paga o próprio Platinum.
- **Mexer na gestão compartilhada pessoal** (grupos/`convites`). São fluxos
  separados e continuam como estão.
- **Log de auditoria** (histórico de quem mudou o quê). A autoria por lançamento
  já cobre 90% da necessidade real; log completo é outra feature.
