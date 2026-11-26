-- 202 — "Trazer movimentações a partir de [data]", por banco conectado.
--
-- Pedido de cliente (26/11/2026): ao conectar, o banco trouxe meses que a
-- pessoa não quer acompanhar, e o botão Atualizar (180 dias) ainda podia trazer
-- meses que nunca tinham vindo. Com a data gravada aqui, NENHUMA sincronização
-- grava movimentação de dia anterior a ela (services/importarDesde.js).
--
-- Sem esta coluna nada quebra: a sincronização grava tudo, como sempre, e a
-- tela diz que a opção ainda está sendo liberada. Rodar de novo é seguro.

alter table public.of_conexoes
  add column if not exists importar_desde date;

comment on column public.of_conexoes.importar_desde is
  'Movimentações do banco com dia (em São Paulo) anterior a esta data não são gravadas por nenhuma sincronização. Null = traz tudo o que o banco enviar.';
