-- =====================================================================
-- 082 — Remédios: baixa por HORÁRIO (fix) + FOTO do medicamento
-- Idempotente.
--
-- Bug corrigido: uma dose não guardava a QUAL horário pertencia, então dar
-- baixa em 1 horário fazia o painel marcar TODOS como tomados. Agora cada
-- dose registra o `horario`, e o painel marca só aquele.
--
-- Melhoria: `foto_url` guarda uma foto do remédio (dataURL) pra identificar
-- visualmente (igual a imagem das metas — sem bucket).
-- =====================================================================

alter table public.medicamento_doses add column if not exists horario time;
alter table public.medicamentos      add column if not exists foto_url text;
