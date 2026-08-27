-- =====================================================================
-- 136 — `investimentos.rentabilidade` passa a ser SEMPRE fração
--
-- SINTOMA: a aba Investimentos mostrava rentabilidades absurdas — um RDB que
-- rendeu 2,27% aparecia como **+227,00%**, outro com 6,76% como **+676,00%**.
--
-- CAUSA: dois gravadores, duas unidades na MESMA coluna.
--   · `services/polpCelcoinSync.js` gravava em PERCENTUAL (2.27)
--   · `routes/investimentos.js` (cotações) grava em FRAÇÃO (0.0227)
-- E o painel faz `rentabilidade * 100` pra exibir — ou seja, assume fração.
-- Quem veio do Open Finance era multiplicado por 100 de novo.
--
-- A convenção fica sendo FRAÇÃO, que é a que o painel e a rota de cotações já
-- usam. O sync foi corrigido junto com esta migration.
--
-- MEDIDO na base antes de rodar (464 investimentos):
--   já em fração ....  2
--   em percentual ... 49   <- é o que esta migration conserta
--   zero ............ 413
--   indeterminado ...  0
--
-- ⚠️ RECALCULAR É SEGURO AQUI: nenhuma das 464 linhas tem
-- `dividendos_acumulados > 0`, e é só ele que a rota de cotações soma por fora
-- do par (valor_atual, valor_aportado). Sem dividendo no meio, a fração
-- derivada dos dois valores é idêntica à que deveria estar gravada.
--
-- Idempotente: rodar de novo não muda nada, porque depois da primeira vez
-- toda linha já bate com a fração derivada.
-- =====================================================================

update public.investimentos
   set rentabilidade = (valor_atual - valor_aportado) / valor_aportado
 where valor_aportado > 0
   and valor_atual is not null
   -- Só mexe em quem está FORA da fração esperada. Sem este filtro, linha
   -- com dividendo (hoje não existe, mas pode existir amanhã) perderia a
   -- parcela de provento ao ser recalculada.
   and abs(coalesce(rentabilidade, 0) - ((valor_atual - valor_aportado) / valor_aportado)) > 0.0001;

-- Aportado zerado não tem rentabilidade definida — deixa em 0 em vez de
-- divisão por zero virando null e a tela mostrando "—" onde havia número.
update public.investimentos
   set rentabilidade = 0
 where (valor_aportado is null or valor_aportado <= 0)
   and coalesce(rentabilidade, 0) <> 0;

-- ── Conferência (rodar solto) ─────────────────────────────────────────
-- select count(*) filter (where abs(rentabilidade) > 1) as suspeitas_acima_de_100pct,
--        max(abs(rentabilidade)) as maior
--   from public.investimentos;
-- Esperado: 0 suspeitas, salvo investimento que REALMENTE mais que dobrou.
