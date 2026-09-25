-- =============================================================================
-- 174_custos_orfaos.sql — carimba `empresa_id` nos custos que nasceram sem ele
--
-- Achado ao converter a aba Negócios pro escopo por empresa (25/09/2026): as
-- 3 linhas de `custos_negocio` da base inteira estão com `empresa_id` NULL.
--
-- ⚠️ NÃO FOI O BACKFILL DA 090 QUE FALHOU — as linhas são de 30/07 e 03/09,
-- DEPOIS de a 090 rodar. A causa é o `POST /api/negocios/custos`, que nunca
-- gravou a coluna: toda linha nova nascia órfã, e o custo ficava fora do DRE
-- por empresa para sempre. O insert foi corrigido junto com esta migration;
-- ela cobre o passado.
--
-- ⚠️ SÓ ATRIBUI QUANDO NÃO HÁ DÚVIDA: o dono precisa ter EXATAMENTE UMA
-- empresa ativa naquele grupo. Um dos 3 donos tem três empresas ("Meu
-- negócio", "Gráfica Rápida Flash Color", "Dom Tv") — escolher uma delas
-- seria jogar o custo no DRE errado, que é pior do que deixá-lo sem empresa.
-- A linha ambígua continua visível pro dono: o GET /custos tem um ramo
-- explícito que devolve as órfãs de quem as lançou.
--
-- Idempotente (o `where empresa_id is null` já garante). Depende da 090.
-- =============================================================================

update public.custos_negocio c
   set empresa_id = e.id
  from public.empresas e
 where c.empresa_id is null
   and e.user_id  = c.user_id
   and e.grupo_id = c.grupo_id
   and e.ativa    = true
   -- a condição que impede o chute: uma empresa só, nenhuma ambiguidade
   and (
     select count(*) from public.empresas e2
      where e2.user_id  = c.user_id
        and e2.grupo_id = c.grupo_id
        and e2.ativa    = true
   ) = 1;

-- Mesma checagem pras irmãs que o `insert` do painel também pode ter deixado
-- em branco. Hoje elas estão zeradas na base, mas a 090 carimbou por
-- `user_id`+`grupo_id` e qualquer linha criada depois teria o mesmo destino.
update public.integracoes t
   set empresa_id = e.id
  from public.empresas e
 where t.empresa_id is null
   and e.user_id = t.user_id and e.grupo_id = t.grupo_id and e.ativa = true
   and (select count(*) from public.empresas e2
         where e2.user_id = t.user_id and e2.grupo_id = t.grupo_id and e2.ativa = true) = 1;

update public.eventos_financeiros t
   set empresa_id = e.id
  from public.empresas e
 where t.empresa_id is null
   and e.user_id = t.user_id and e.grupo_id = t.grupo_id and e.ativa = true
   and (select count(*) from public.empresas e2
         where e2.user_id = t.user_id and e2.grupo_id = t.grupo_id and e2.ativa = true) = 1;

-- ⚠️ O upsert de `config_negocio` apontava pra `onConflict: 'user_id'`, mas a
-- 090 §4 trocou a PK pra `empresa_id`. Com uma empresa só ninguém sentiu (1
-- linha na base); com duas, a config da segunda colidiria com a da primeira.
-- O código passou a usar `empresa_id` — esta unique é o que sustenta isso.
create unique index if not exists config_negocio_empresa_uidx
  on public.config_negocio (empresa_id);
