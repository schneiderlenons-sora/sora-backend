-- =============================================================================
-- 173_empresa_membros.sql — EQUIPE dentro da empresa (Negócios multiusuário)
--
-- Relato de cliente Platinum com 6 lojas (24/09/2026): "diferentes membros do
-- financeiro, cada um pelo seu próprio WhatsApp, acessando a mesma empresa e
-- alimentando a mesma base. Só encontrei a opção de criar outra conta pessoal,
-- o que cria um acesso separado. Não é isso que preciso."
--
-- ⚠️ POR QUE NÃO REUSAR O GRUPO PESSOAL (`grupos` / `grupo_membros`), que é a
-- solução aparentemente óbvia: entrar no grupo dá acesso ao PAINEL PESSOAL
-- INTEIRO do dono — transações, contas bancárias, cartões, metas, dívidas,
-- limites, previstos e relatórios. Para pôr um funcionário do financeiro na
-- empresa, o cliente teria de mostrar a ele o próprio dinheiro pessoal.
-- Gestão compartilhada (casal/família) e equipe de empresa são coisas
-- diferentes, e continuam separadas.
--
-- ⚠️ E o caso dele já mostra o segundo motivo: com 6 empresas, escopo por grupo
-- daria a todo convidado a REDE INTEIRA. Um gerente de loja precisa da loja
-- dele. Por isso o vínculo é POR EMPRESA.
--
-- Esta migration é INERTE: nada no código lê estas tabelas ainda (Fase 1 do
-- docs/PLANO-NEGOCIOS-MULTIUSUARIO.md). Depende da 090 (empresas). Idempotente.
-- =============================================================================

create table if not exists public.empresa_membros (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  user_id       uuid not null references public.users(id)    on delete cascade,

  -- admin    → tudo, inclusive convidar/remover membro e apagar a empresa
  -- operador → lança, paga, dá baixa, cadastra cliente/produto/fornecedor
  -- leitura  → só vê (DRE, caixa, relatórios) — é o papel do contador
  papel         text not null default 'operador',

  -- Empresa que a Sora assume quando a pessoa manda mensagem sem dizer qual.
  -- ⚠️ Sem isto, quem opera 6 lojas seria perguntado a cada lançamento.
  padrao        boolean not null default false,

  convidado_por uuid references public.users(id),
  created_at    timestamptz not null default now(),

  -- Uma linha por pessoa por empresa: é o que faz o convite ser idempotente
  -- (aceitar duas vezes não duplica o vínculo nem troca o papel por acidente).
  unique (empresa_id, user_id)
);

-- Recriado sempre: se um dia entrar 'financeiro' ou 'vendedor', esta é a linha
-- a mexer. ⚠️ Mesma família do `users_plano_check` e do
-- `investimentos_tipo_check` — papel novo na aplicação que não esteja aqui faz
-- a gravação falhar CALADA.
alter table public.empresa_membros
  drop constraint if exists empresa_membros_papel_check;
alter table public.empresa_membros
  add constraint empresa_membros_papel_check
  check (papel in ('admin', 'operador', 'leitura'));

-- ⚠️ BACKFILL OBRIGATÓRIO: todo dono vira admin da própria empresa. Sem ele, no
-- instante em que a leitura passar a consultar esta tabela (Fase 2), TODO MUNDO
-- perde a própria empresa. Rodar a 173 sem esta linha é pior que não rodar.
insert into public.empresa_membros (empresa_id, user_id, papel)
select e.id, e.user_id, 'admin'
  from public.empresas e
 where e.user_id is not null
on conflict (empresa_id, user_id) do nothing;

-- O índice que importa: "quais empresas eu alcanço?" é a consulta de toda
-- requisição da aba Negócios.
create index if not exists idx_empresa_membros_user
  on public.empresa_membros (user_id);
create index if not exists idx_empresa_membros_empresa
  on public.empresa_membros (empresa_id);

-- ── CONVITE POR EMPRESA ─────────────────────────────────────────────────────
--
-- ⚠️ Tabela PRÓPRIA, não a `convites` existente: aquela é por GRUPO e serve à
-- gestão compartilhada pessoal. Misturar as duas faria um convite de empresa
-- poder cair num grupo pessoal (e vice-versa), que é exatamente a confusão que
-- este plano existe para desfazer.
create table if not exists public.convites_empresa (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  codigo      text not null unique,
  -- O papel já vai decidido no convite: quem convida sabe se está chamando um
  -- operador ou o contador. Evita o vínculo nascer com poder demais.
  papel       text not null default 'operador',
  criado_por  uuid references public.users(id),
  expira_em   timestamptz not null,
  usado       boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.convites_empresa
  drop constraint if exists convites_empresa_papel_check;
alter table public.convites_empresa
  add constraint convites_empresa_papel_check
  check (papel in ('admin', 'operador', 'leitura'));

create index if not exists idx_convites_empresa_codigo
  on public.convites_empresa (codigo);
