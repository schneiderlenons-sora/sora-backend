-- ─────────────────────────────────────────────────────────────────────────────
-- 166 — Quando o usuário abriu a Sora pela primeira vez DENTRO do app Android.
--
-- É o sinal que faz a barra de convite da Play Store SUMIR
-- (sora-frontend/components/app/BarraPlayStore.tsx).
--
-- ⚠️ POR QUE UMA COLUNA E NÃO SÓ O localStorage. O app Android (TWA) roda no
-- Chrome do aparelho e compartilha o armazenamento com ele — então quem usa o
-- Chrome já teria a marca. Mas quem navega pelo Samsung Internet (ou qualquer
-- outro navegador) não compartilha nada com o app, e continuaria vendo o
-- convite depois de instalar. Guardado no usuário, o sinal vale em qualquer
-- navegador.
--
-- ⚠️ SEM ESTA MIGRATION NADA QUEBRA: `/api/me` lê `select('*')`, então a coluna
-- ausente só significa "ainda não instalou" e a barra continua aparecendo pra
-- quem usa o navegador. Dentro do próprio app ela já some pela detecção local.
--
-- Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.users
  add column if not exists app_android_em timestamptz;

comment on column public.users.app_android_em is
  'Primeira vez que o usuário abriu a Sora dentro do app Android (TWA). Esconde o convite da Play Store.';
