-- 048: personalização do avatar do usuário.
-- Além da foto (avatar_url), o usuário pode escolher um ÍCONE pré-definido
-- (baleias) e uma COR de fundo. Prioridade de exibição: foto > preset > inicial.
-- Idempotente.

alter table public.users
  add column if not exists avatar_preset text,
  add column if not exists avatar_cor    text;
