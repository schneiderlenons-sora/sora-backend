-- ═══════════════════════════════════════════════════════════════════════════
-- 142 — Plano PLATINUM + aposentadoria do Black + grandfathering do Negócios
--
-- O QUE MUDA
--   1. Nasce o plano 'platinum' (R$49,90/mês · R$479/ano): tudo do Premium
--      + aba Negócios + 5 conexões de Open Finance + suporte prioritário.
--   2. O 'black' morre de vez. Ele já era idêntico ao Premium desde 2026;
--      sobrava só no CHECK e em ~45 arquivos de código.
--   3. A aba Negócios SAI do Premium e passa a ser do Platinum.
--
-- ⚠️ POR QUE A COLUNA `negocios_liberado` EXISTE
--   Tirar Negócios do Premium sem mais nada tomaria a aba de quem já a usa —
--   MEDIDO: 18 empresas cadastradas, de 15 usuários. Ninguém pode abrir o
--   painel amanhã e encontrar um paywall no lugar do próprio DRE.
--
--   Não dá pra resolver por data de cadastro nem por "tem empresa": quem tem
--   acesso e ainda não cadastrou empresa também comprou esse direito. A coluna
--   marca explicitamente QUEM JÁ TINHA, e o gate passa a ser
--   `platinum OU vitalício OU negocios_liberado`.
--
-- ⚠️ MESMA FAMÍLIA DO `users_plano_check` (memória project-plano-check-constraint)
--   Plano novo que não entra no CHECK faz a ativação falhar EM SILÊNCIO — o
--   Stripe cobra e o plano não sobe. Conferido antes de escrever esta migration:
--   o CHECK atual RECUSA 'platinum'.
--
-- ORDEM IMPORTA: a coluna e o backfill vêm ANTES de qualquer troca de plano,
-- senão o `where plano in ('premium','black')` do backfill já não encontra
-- quem virou platinum.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Grandfathering: quem tem Negócios HOJE não perde ────────────────────
alter table users add column if not exists negocios_liberado boolean not null default false;

comment on column users.negocios_liberado is
  'Acesso vitalício à aba Negócios concedido antes de ela virar exclusiva do Platinum (migration 142). Nunca revogar automaticamente.';

-- Todo mundo que enxerga a aba hoje: premium e black (o gate antigo era
-- exatamente `plano === premium || plano === black`).
update users
   set negocios_liberado = true
 where plano in ('premium', 'black')
   and negocios_liberado is distinct from true;

-- ─── 2. CHECK aceitando platinum ────────────────────────────────────────────
-- Em dois tempos: aqui 'black' AINDA é aceito, porque as linhas black só serão
-- convertidas no passo 3. Recriar o CHECK sem ele agora faria o próprio ALTER
-- falhar na validação das linhas existentes.
alter table users drop constraint if exists users_plano_check;
alter table users add constraint users_plano_check
  check (plano in ('inativo', 'basico', 'kit', 'premium', 'platinum', 'black'));

-- ─── 3. Admin vira Platinum ─────────────────────────────────────────────────
-- As duas contas do dono (a principal, hoje o ÚNICO black da base, e a de
-- gravação/demonstração).
update users
   set plano = 'platinum'
 where lower(email) in ('schineiderlenon@gmail.com', 'comercialsora@gmail.com');

-- ─── 4. Sobra de black → premium ────────────────────────────────────────────
-- Rede de segurança. Medido antes de rodar: 1 linha black, e ela é a do admin
-- (já convertida acima), então isto tende a afetar 0 linhas. Fica porque o
-- CHECK do passo 5 não pode encontrar nenhum black de pé — e porque o código
-- deixa de conhecer 'black' completamente: uma linha esquecida perderia TODAS
-- as features de uma vez.
update users set plano = 'premium' where plano = 'black';

-- ─── 5. CHECK final, sem black ──────────────────────────────────────────────
alter table users drop constraint if exists users_plano_check;
alter table users add constraint users_plano_check
  check (plano in ('inativo', 'basico', 'kit', 'premium', 'platinum'));

commit;

-- ─── Conferência ────────────────────────────────────────────────────────────
-- select plano, count(*), count(*) filter (where negocios_liberado) as com_negocios
--   from users group by plano order by 2 desc;
--
-- Esperado: nenhuma linha 'black'; 2 linhas 'platinum'; e o total de
-- negocios_liberado = quantos eram premium/black antes desta migration (69).
