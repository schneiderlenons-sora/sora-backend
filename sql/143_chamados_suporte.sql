-- ═══════════════════════════════════════════════════════════════════════════
-- 143 — Chamados de suporte com conversa no painel
--
-- Hoje o relato é uma via de mão única: o usuário escreve, a mensagem cai no
-- WhatsApp do suporte e ACABA. A resposta do admin não fica salva em lugar
-- nenhum, o usuário não tem como responder pelo painel, e a imagem que ele
-- anexou é DESCARTADA (só sobra o booleano `tem_imagem`).
--
-- Esta migration cria as duas peças que faltam:
--   1. `bug_mensagens` — a conversa, dos dois lados.
--   2. bucket `bug-anexos` — onde o print passa a ser guardado de verdade.
--
-- ⚠️ A MENSAGEM DE ABERTURA CONTINUA EM `bug_reports.mensagem`, e não vira
-- linha em `bug_mensagens`. Isso é de propósito: ao FECHAR o chamado a
-- conversa é apagada (pedido do dono), e se a abertura estivesse junto o
-- histórico do bug morreria com ela — os contadores do admin
-- (bugsAbertos/melhoriasAbertas) e a memória do que já foi relatado dependem
-- dela. Fecha o chamado: some o bate-papo, fica o relato.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Anexo do relato de abertura ─────────────────────────────────────────
-- `tem_imagem` (boolean) fica: é o que o código antigo lê, e serve de registro
-- histórico de "teve print" pros relatos anteriores a esta migration, cuja
-- imagem se perdeu de vez.
alter table bug_reports add column if not exists imagem_path text;

comment on column bug_reports.imagem_path is
  'Caminho do print no bucket bug-anexos. NULL em relato sem imagem — e nos relatos anteriores à migration 143, cuja imagem foi descartada.';

-- ─── 2. Conversa do chamado ─────────────────────────────────────────────────
create table if not exists public.bug_mensagens (
  id          uuid primary key default gen_random_uuid(),
  -- ⚠️ `on delete cascade`: apagar o relato leva a conversa junto. Conversa
  -- órfã de chamado inexistente não tem como ser lida nem limpa depois.
  bug_id      uuid not null references public.bug_reports(id) on delete cascade,
  -- Quem falou. 'suporte' é sempre o admin; 'usuario' é quem abriu.
  autor       text not null check (autor in ('usuario', 'suporte')),
  -- `user_id` do autor quando é o usuário — serve pra auditoria e pra barrar
  -- que alguém responda no chamado de outra pessoa.
  autor_id    uuid references public.users(id) on delete set null,
  texto       text not null,
  imagem_path text,
  -- Quando o OUTRO lado leu. Null = não lido. É o que acende o badge.
  lida_em     timestamptz,
  created_at  timestamptz default now()
);

create index if not exists idx_bug_msg_bug  on public.bug_mensagens(bug_id, created_at);
-- Parcial: a busca que importa é "o que ainda não foi lido".
create index if not exists idx_bug_msg_nlida on public.bug_mensagens(bug_id) where lida_em is null;

-- ─── 3. Bucket dos anexos ───────────────────────────────────────────────────
-- PRIVADO, como o `dados-arquivos` (migration 042): print de tela costuma
-- mostrar saldo, extrato e nome — não pode ficar em URL pública adivinhável.
-- O acesso sai por URL assinada gerada no backend com service role.
--
-- 6 MB = o mesmo teto que a tela de relato já aplica (MAX_IMG em
-- app/reportar-bug/page.tsx). Números diferentes fariam o upload passar no
-- navegador e morrer no storage.
insert into storage.buckets (id, name, public, file_size_limit)
values ('bug-anexos', 'bug-anexos', false, 6291456)
on conflict (id) do nothing;

commit;

-- ─── Conferência ────────────────────────────────────────────────────────────
-- select count(*) from bug_mensagens;
-- select id, name, public, file_size_limit from storage.buckets where id = 'bug-anexos';
