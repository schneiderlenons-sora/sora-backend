-- =====================================================================
-- 016 — Sora Negócios (CFO de bolso / DRE inteligente)
-- Tabelas: integracoes, eventos_financeiros, dre_snapshots,
--          custos_negocio, conciliacao_transacao, config_negocio
-- Idempotente.
-- =====================================================================

-- ── INTEGRAÇÕES (credenciais criptografadas + estado de sync) ─────
create table if not exists public.integracoes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  grupo_id          uuid not null references public.grupos(id) on delete cascade,
  plataforma        text not null check (plataforma in (
                      'hotmart','kiwify','eduzz','stripe','mercadopago',
                      'asaas','pagseguro','shopify','woocommerce'
                    )),
  apelido           text,
  credenciais       jsonb not null default '{}'::jsonb, -- tokens / api keys (criptografado pela app layer)
  webhook_secret    text,
  status            text default 'ativa' check (status in ('ativa','erro','pausada','revogada')),
  ultimo_erro       text,
  ultimo_sync       timestamptz,
  proximo_sync      timestamptz,
  sincronizando     boolean default false,
  total_eventos     int default 0,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_integracoes_user on public.integracoes(user_id);
create index if not exists idx_integracoes_grupo on public.integracoes(grupo_id);
create index if not exists idx_integracoes_status on public.integracoes(status) where status = 'ativa';

-- ── EVENTOS FINANCEIROS (fonte da verdade — toda venda/refund/etc) ─
create table if not exists public.eventos_financeiros (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  grupo_id            uuid not null references public.grupos(id) on delete cascade,
  integracao_id       uuid not null references public.integracoes(id) on delete cascade,
  plataforma          text not null,
  -- identificação na plataforma de origem (evita duplicatas)
  ref_externa         text not null,
  tipo                text not null check (tipo in (
                        'venda','reembolso','chargeback','assinatura_renovacao',
                        'assinatura_cancelamento','comissao_afiliado','saque','ajuste'
                      )),
  -- produto / oferta
  produto_id_externo  text,
  produto_nome        text,
  oferta              text,
  -- valores (em centavos para precisão)
  valor_bruto         bigint not null default 0,
  taxa_plataforma     bigint not null default 0,
  taxa_gateway        bigint not null default 0,
  imposto             bigint not null default 0,
  valor_liquido       bigint not null default 0,
  moeda               text default 'BRL',
  -- comprador
  comprador_nome      text,
  comprador_email     text,
  comprador_doc       text,
  -- afiliado / recorrência
  afiliado_nome       text,
  comissao_afiliado   bigint default 0,
  recorrencia         text check (recorrencia in ('avulsa','mensal','trimestral','semestral','anual') or recorrencia is null),
  assinatura_id       text,
  -- status do evento
  status              text default 'aprovado' check (status in (
                        'aprovado','pendente','recusado','estornado','expirado','cancelado'
                      )),
  -- conciliação com Sora Finance
  conciliado          boolean default false,
  transacao_id        uuid references public.transacoes(id) on delete set null,
  -- metadata flexível por plataforma
  metadata            jsonb default '{}'::jsonb,
  data_evento         timestamptz not null,
  data_capturada      timestamptz default now(),
  unique(integracao_id, ref_externa)
);

create index if not exists idx_eventos_user on public.eventos_financeiros(user_id);
create index if not exists idx_eventos_grupo on public.eventos_financeiros(grupo_id);
create index if not exists idx_eventos_data on public.eventos_financeiros(data_evento desc);
create index if not exists idx_eventos_periodo on public.eventos_financeiros(user_id, date_trunc('month', data_evento));
create index if not exists idx_eventos_produto on public.eventos_financeiros(produto_nome);
create index if not exists idx_eventos_tipo on public.eventos_financeiros(tipo);

-- ── CUSTOS DO NEGÓCIO (tráfego pago, ferramentas, equipe, etc.) ────
create table if not exists public.custos_negocio (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  categoria     text not null check (categoria in (
                  'trafego_pago','ferramentas','equipe','assinaturas',
                  'mentoria','infra','operacional','outros'
                )),
  fornecedor    text,
  descricao     text not null,
  valor         bigint not null, -- centavos
  data          date not null,
  recorrente    boolean default false,
  recorrencia   text check (recorrencia in ('mensal','trimestral','anual') or recorrencia is null),
  -- conciliação opcional com transação Sora Finance
  transacao_id  uuid references public.transacoes(id) on delete set null,
  observacao    text,
  created_at    timestamptz default now()
);

create index if not exists idx_custos_user_data on public.custos_negocio(user_id, data desc);
create index if not exists idx_custos_categoria on public.custos_negocio(categoria);

-- ── CONFIG DO NEGÓCIO (regime tributário, alíquotas, preferências) ─
create table if not exists public.config_negocio (
  user_id            uuid primary key references public.users(id) on delete cascade,
  grupo_id           uuid not null references public.grupos(id) on delete cascade,
  regime_tributario  text default 'mei' check (regime_tributario in ('mei','simples','lucro_presumido','lucro_real','pf')),
  aliquota_simples   numeric(5,2) default 6.00,  -- % padrão Simples Nacional Anexo III
  reservar_imposto   boolean default true,        -- separa % automaticamente como reserva
  pct_reserva_imposto numeric(5,2) default 6.00,
  fechamento_dia     int default 1 check (fechamento_dia between 1 and 28),
  moeda_principal    text default 'BRL',
  notificar_meta_lucro bigint, -- centavos; alerta quando lucro do mês atingir
  ai_insights_ativo  boolean default true,
  updated_at         timestamptz default now()
);

-- ── DRE SNAPSHOTS (cache pré-calculado por mês) ────────────────────
create table if not exists public.dre_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  grupo_id            uuid not null references public.grupos(id) on delete cascade,
  periodo             date not null, -- primeiro dia do mês
  -- agregados em centavos
  receita_bruta       bigint default 0,
  taxas_plataforma    bigint default 0,
  taxas_gateway       bigint default 0,
  impostos            bigint default 0,
  reembolsos          bigint default 0,
  chargebacks         bigint default 0,
  comissoes_afiliado  bigint default 0,
  receita_liquida     bigint default 0,
  custos_total        bigint default 0,
  custos_por_categoria jsonb default '{}'::jsonb,
  lucro_liquido       bigint default 0,
  margem_pct          numeric(6,2) default 0,
  -- métricas
  total_vendas        int default 0,
  ticket_medio        bigint default 0,
  mrr                 bigint default 0,
  arr                 bigint default 0,
  churn_pct           numeric(6,2) default 0,
  -- breakdown
  por_plataforma      jsonb default '[]'::jsonb, -- [{plataforma, valor, vendas}]
  por_produto         jsonb default '[]'::jsonb, -- top 10
  gerado_em           timestamptz default now(),
  unique(user_id, periodo)
);

create index if not exists idx_dre_user_periodo on public.dre_snapshots(user_id, periodo desc);

-- ── CONCILIAÇÃO: link eventos_financeiros ⇄ transacoes (Sora Finance)
-- Quando uma venda na Hotmart cai no banco do usuário (já trackeado pela Sora),
-- esta tabela garante que não conte 2x e mostra origem.
create table if not exists public.conciliacao_negocio (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  evento_id     uuid not null references public.eventos_financeiros(id) on delete cascade,
  transacao_id  uuid not null references public.transacoes(id) on delete cascade,
  match_tipo    text default 'manual' check (match_tipo in ('manual','automatico','sugerido')),
  confianca     numeric(4,2), -- 0..1 quando automático
  conciliado_em timestamptz default now(),
  unique(evento_id, transacao_id)
);

create index if not exists idx_conciliacao_user on public.conciliacao_negocio(user_id);

-- ── ALERTAS / INSIGHTS DA IA ───────────────────────────────────────
create table if not exists public.insights_negocio (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  grupo_id     uuid not null references public.grupos(id) on delete cascade,
  tipo         text not null check (tipo in (
                 'lucro_subiu','lucro_caiu','meta_atingida','plataforma_top',
                 'produto_top','custo_alto','imposto_reservar','vendas_recorde',
                 'churn_alto','assinatura_cancelada','fluxo_caixa_alerta','sugestao'
               )),
  severidade   text default 'info' check (severidade in ('info','sucesso','atencao','critico')),
  titulo       text not null,
  descricao    text,
  acao_label   text,
  acao_url     text,
  dados        jsonb default '{}'::jsonb,
  visto        boolean default false,
  dispensado   boolean default false,
  created_at   timestamptz default now()
);

create index if not exists idx_insights_user_visto on public.insights_negocio(user_id, visto, created_at desc);
