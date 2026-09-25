-- =============================================================================
-- 175_of_conexao_diagnostico.sql — guardar O QUE O BANCO LIBEROU na conexão
--
-- Relato de cliente (Vander, 25/09/2026): o cartão do BTG não aparece. Ele já
-- removeu a conexão na Sora, removeu TODAS as conexões no app do BTG e
-- reconectou do zero — três vezes. A conta vem; o cartão não.
--
-- ⚠️ O QUE ESTA MIGRATION RESOLVE NÃO É O CARTÃO — É A CEGUEIRA.
-- Ao investigar, descobriu-se que `of_conexoes` não guarda NADA sobre o que
-- foi pedido nem sobre o que foi concedido:
--
--   · `criarConsentimento` tem três tentativas em cascata (omitir `products`
--     → ACCOUNT+CREDIT_CARD_ACCOUNT → só ACCOUNT). A doc da Celcoin diz que
--     omitir "solicita os cinco produtos", então o caminho normal INCLUI
--     cartão — mas se as duas primeiras derem 422, a terceira pede SÓ CONTA e
--     o consentimento nasce, legitimamente autorizado, sem cartão nenhum.
--     Sintoma idêntico ao do relato.
--   · O resultado dessa escolha ia só para um `console.log` do Render. Sem o
--     log daquele minuto, não existe como saber qual tentativa venceu.
--
-- Ou seja: não dava para distinguir "o banco não liberou o cartão" de "a Sora
-- não pediu o cartão" — e são coisas opostas, uma é problema do provedor e a
-- outra é bug nosso. Sem isso, o cliente reconecta às cegas e cada volta cria
-- um consentimento novo, que a Polp cobra.
--
-- Idempotente. Depende da 069 (of_conexoes).
-- =============================================================================

-- Produtos que o consentimento carrega (ACCOUNT, CREDIT_CARD_ACCOUNT, …), como
-- a Celcoin os devolve no create. É a resposta para "a Sora pediu o cartão?".
alter table public.of_conexoes
  add column if not exists produtos text[];

-- Recursos que a instituição de fato expôs, de `GET /consents/{id}/resources`:
-- [{ "type": "CREDIT_CARD_ACCOUNT", "status": "UNAVAILABLE" }, …].
-- É a resposta para "o BANCO liberou o cartão?" — e é a única fonte que
-- distingue UNAVAILABLE (encerrado) de TEMPORARILY_UNAVAILABLE (a doc manda
-- fazer retry antes de avisar o usuário).
alter table public.of_conexoes
  add column if not exists recursos jsonb;

-- Quando a lista acima foi lida. Sem isto não dá para saber se o diagnóstico
-- na tela é de agora ou de duas semanas atrás — e o status pode ter mudado.
alter table public.of_conexoes
  add column if not exists recursos_em timestamptz;
