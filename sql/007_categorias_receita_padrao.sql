-- =====================================================================
-- 007 — Adiciona categorias padrão de RECEITA para todos os grupos
-- Idempotente: ON CONFLICT DO NOTHING evita duplicar.
-- =====================================================================

do $$
declare
  g record;
  cat record;
begin
  for g in select id from public.grupos loop
    for cat in
      select * from (values
        ('Freelance',        '💻'),
        ('Bônus',            '🎁'),
        ('Aluguel Recebido', '🏘️'),
        ('Rendimentos',      '📈'),
        ('Dividendos',       '💰'),
        ('Presente',         '🎀'),
        ('Venda de itens',   '📦'),
        ('Outras receitas',  '🪙')
      ) as t(nome, icone)
    loop
      insert into public.categorias (grupo_id, nome, icone, ativa)
      values (g.id, cat.nome, cat.icone, true)
      on conflict do nothing;
    end loop;
  end loop;
end $$;
