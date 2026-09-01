-- =====================================================================
-- 145 — Índice de `regras_categoria` que o UPSERT consegue usar
--
-- ⚠️ A migration 104 criou o índice único sobre uma EXPRESSÃO:
--        (grupo_id, lower(btrim(termo)))
--    e o `salvarRegra` fazia `upsert(..., onConflict: 'grupo_id,termo')`.
--    O Postgres NÃO casa `ON CONFLICT (colunas)` com índice de expressão e
--    devolve 42P10. Toda criação de regra falhava — e falhava CALADA, porque o
--    `PUT /api/transacoes/:id` chama aquilo dentro de um try/catch best-effort.
--    Resultado medido em set/2026: ZERO regras na base inteira, enquanto 69
--    descrições se repetiam 3+ vezes paradas em "Outros".
--
-- O código já foi corrigido pra não depender de `ON CONFLICT` (agora é
-- UPDATE-e-senão-INSERT, que funciona com qualquer um dos dois índices). Esta
-- migration alinha o banco: o índice passa a ser sobre as COLUNAS, que é o que
-- qualquer upsert futuro vai esperar.
--
-- ✅ SEGURO: `termo` é SEMPRE gravado normalizado (`termoDe` → minúsculo, sem
--    acento e sem pontuação), então `lower(btrim(termo)) = termo` para toda
--    linha existente. Os dois índices são equivalentes na prática — trocar não
--    permite nenhuma duplicata que o anterior barrava.
--
-- Idempotente.
-- =====================================================================

-- Índice novo, sobre as colunas.
create unique index if not exists uq_regras_categoria_grupo_termo_col
  on public.regras_categoria (grupo_id, termo);

-- O de expressão vira redundante: mesma garantia, e ninguém mais o consulta.
drop index if exists public.uq_regras_categoria_grupo_termo;

-- =====================================================================
-- Verificação:
--   select indexname from pg_indexes
--    where tablename = 'regras_categoria';
--   -- esperado: uq_regras_categoria_grupo_termo_col + idx_regras_categoria_grupo
--
--   -- e o upsert volta a funcionar:
--   insert into public.regras_categoria (grupo_id, termo, categoria)
--   values ('<um_grupo>', 'teste', 'Casa')
--   on conflict (grupo_id, termo) do update set categoria = excluded.categoria;
--   -- (apague a linha de teste depois)
-- =====================================================================
