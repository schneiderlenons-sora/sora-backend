-- 061_plano_kit.sql
-- O CHECK constraint `users_plano_check` só permitia inativo/basico/premium/black,
-- então o UPDATE plano='kit' (ativação do Kit vitalício R$47) VIOLAVA o constraint
-- e falhava silenciosamente → o plano ficava 'inativo' pra sempre.
--
-- Corrige incluindo 'kit' na lista de valores permitidos.
-- NOT VALID: não revalida linhas antigas (evita travar por algum valor legado),
-- mas JÁ passa a valer pra todo INSERT/UPDATE novo. Idempotente.

alter table public.users drop constraint if exists users_plano_check;

alter table public.users
  add constraint users_plano_check
  check (plano in ('inativo', 'basico', 'kit', 'premium', 'black'))
  not valid;
