-- =====================================================================
-- 086 — Limpa a categoria bug "__probe__" + move Nike/Adidas/Shein pra Encomendas
--
-- "__probe__" NÃO é criada por nenhum código (varrido backend+frontend+SQL) →
-- é uma linha solta (provável teste manual no SQL Editor). Não é sistemática;
-- este delete a remove de QUALQUER grupo por segurança.
--
-- Nike/Adidas/Shein: na taxonomia v3 (084) elas moram em "Encomendas", mas em
-- quem tinha o Vestuário antigo a 085 as reparentou pra "Compras" junto. Aqui
-- corrigimos pro pai certo.
--
-- Quantos grupos têm o probe? rode antes:
--   select count(*) from public.categorias where lower(btrim(nome)) = '__probe__';
--
-- Idempotente.
-- =====================================================================

-- ── 1) Remove "__probe__" em todo grupo (nome EXATO — '=' trata '_' literal) ──
-- Solta eventuais filhos primeiro (não deixa órfão), depois deleta a linha.
update public.categorias set parent_id = null
 where parent_id in (select id from public.categorias where lower(btrim(nome)) = '__probe__')
   and lower(btrim(nome)) <> '__probe__';

delete from public.categorias where lower(btrim(nome)) = '__probe__';

-- ── 2) Move Nike/Adidas/Shein pro pai "Encomendas" (por grupo) ──────────
do $$
declare g record; v_enc uuid;
begin
  for g in select id from public.grupos loop
    select id into v_enc from public.categorias
     where grupo_id = g.id and parent_id is null and coalesce(ativa, true) = true
       and lower(btrim(nome)) = 'encomendas'
     limit 1;
    if v_enc is null then continue; end if;
    update public.categorias set parent_id = v_enc
     where grupo_id = g.id and coalesce(ativa, true) = true
       and lower(btrim(nome)) in ('nike', 'adidas', 'shein')
       and id <> v_enc and parent_id is distinct from v_enc;
  end loop;
end; $$;

-- =====================================================================
-- Verificação:
--   select count(*) from public.categorias where lower(btrim(nome)) = '__probe__'; -- 0
--   select c.nome, p.nome as pai from public.categorias c
--     join public.categorias p on p.id = c.parent_id
--    where c.grupo_id = '<seu_grupo>' and lower(c.nome) in ('nike','adidas','shein');
--   -- todas com pai = Encomendas
-- =====================================================================
