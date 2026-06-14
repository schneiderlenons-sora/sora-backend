-- =====================================================================
-- 042 — Bucket privado pros arquivos da aba Dados Pessoais (currículos,
-- documentos). Upload/download via URLs assinadas geradas no backend
-- (service role) — o bucket NÃO é público.
--
-- Limite de 10 MB por arquivo. Idempotente.
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('dados-arquivos', 'dados-arquivos', false, 10485760)
on conflict (id) do nothing;
