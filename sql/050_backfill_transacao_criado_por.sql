-- 050: backfill do criado_por em transações antigas.
-- Transações criadas pelo WhatsApp (antes do fix) ficaram com criado_por NULL,
-- então o avatar de "quem fez" não aparecia. Preenche com o dono do grupo.
-- (Histórico: o melhor palpite é o dono; novas transações já gravam o autor real.)
-- Idempotente.

update public.transacoes t
   set criado_por = g.dono_id
  from public.grupos g
 where g.id = t.grupo_id
   and t.criado_por is null;
