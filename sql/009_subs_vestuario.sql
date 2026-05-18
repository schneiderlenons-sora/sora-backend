-- =====================================================================
-- 009 — Subcategorias padrão de Vestuário (Nike, Adidas, Shein)
-- Idempotente: só insere se ainda não existir.
-- =====================================================================

do $$
declare
  v_cat record;
  v_sub record;
begin
  for v_cat in
    select c.id as cat_id, c.grupo_id
      from public.categorias c
     where c.parent_id is null
       and lower(c.nome) like '%vestu%'
  loop
    for v_sub in
      select * from (values
        ('Nike',   '👟'),
        ('Adidas', '👟'),
        ('Shein',  '👕')
      ) as t(nome, icone)
    loop
      if not exists (
        select 1 from public.categorias
         where grupo_id = v_cat.grupo_id
           and parent_id = v_cat.cat_id
           and lower(nome) = lower(v_sub.nome)
      ) then
        insert into public.categorias (grupo_id, parent_id, nome, icone, ativa)
        values (v_cat.grupo_id, v_cat.cat_id, v_sub.nome, v_sub.icone, true);
      end if;
    end loop;
  end loop;
end $$;
