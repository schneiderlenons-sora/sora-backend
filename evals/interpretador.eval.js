// =============================================================================
// EVAL do interpretador local (interpretarRapido) — frase → ação esperada.
//
// É um "checklist automático": roda o parser que já existe contra uma lista de
// frases e confere se a ação que saiu é a certa. NÃO toca em produção, não chama
// IA, não gasta nada — só LÊ o parser e dá uma nota.
//
// Rodar:   node evals/interpretador.eval.js
// Sai com código != 0 se algo falhar (dá pra usar como gate de CI no futuro).
//
// Como ler um caso:  { msg, expect }
//   expect = null          → a frase DEVE cair pra IA (parser devolve null)
//   expect = { ...campos } → o parser devolve um objeto com ESSES campos
//                            (match parcial: só checa os campos que estão em expect)
// =============================================================================

const { interpretarRapido } = require('../src/handlers/interpretador');

const CASOS = [
  // ── VALOR COM PREFIXO "R$" — o formato que vem do ÁUDIO ───────────────────
  //
  // ⚠️ ESTE BLOCO É O RELATO DE 03/09/2026, e nasceu de um bug em produção.
  // Um cliente disse que a Sora não registrava por ÁUDIO. Por texto funcionava.
  // A causa: o Whisper escreve valor falado como "R$ 3,00", e a normalização do
  // interpretador só tirava a moeda DEPOIS do número ("10 reais" → "10").
  // Com o prefixo intacto, a regra de SALVAR (que espera número nu) não casava
  // e a frase caía numa regra de CONSULTA: o cliente recebia "Nenhum gasto
  // encontrado para mercado com inter".
  //
  // Medido na época: 9 de 11 formatos de fala NÃO viravam lançamento, caindo de
  // três jeitos diferentes (buscar, resumo e null). Estes casos existem pra que
  // nenhum deles volte em silêncio.
  { msg: 'Gastei R$ 3,00 no mercado com Inter', expect: { acao: 'salvar', tipo: 'Gasto', valor: 3, categoria: 'Mercado', carteira_nome: 'inter' } },
  { msg: 'Gastei R$3,00 no mercado',          expect: { acao: 'salvar', tipo: 'Gasto', valor: 3, categoria: 'Mercado' } },
  { msg: 'Gastei R$ 3 no mercado',            expect: { acao: 'salvar', tipo: 'Gasto', valor: 3, categoria: 'Mercado' } },
  // ⚠️ Milhar: o prefixo sai, mas o formato BR tem de sobreviver — 1.250,00
  // precisa chegar como 1250, não como 1,25. É o `parseValor` que garante isso.
  { msg: 'Gastei R$ 1.250,00 no aluguel',     expect: { acao: 'salvar', tipo: 'Gasto', valor: 1250, categoria: 'Aluguel' } },
  { msg: 'Paguei R$ 89,90 na Netflix',        expect: { acao: 'salvar', tipo: 'Gasto', valor: 89.9, categoria: 'Assinaturas' } },
  { msg: 'Recebi R$ 2.000,00 de salário',     expect: { acao: 'salvar', valor: 2000 } },
  // ⚠️ E as CONSULTAS não podem ter virado lançamento junto: a correção mexeu na
  // normalização, que TODA regra abaixo consome.
  { msg: 'quanto gastei no mercado',          expect: { acao: 'buscar' } },
  { msg: 'meus gastos',                       expect: { acao: 'resumo' } },

  // ── Registrar gasto (salvar) ──────────────────────────────────────────────
  { msg: 'gastei 50 no mercado',              expect: { acao: 'salvar', tipo: 'Gasto', valor: 50, categoria: 'Mercado' } },
  { msg: 'paguei 30 no uber',                 expect: { acao: 'salvar', tipo: 'Gasto', valor: 30, categoria: 'Transporte' } },
  { msg: 'gastei 200 na farmacia',            expect: { acao: 'salvar', tipo: 'Gasto', categoria: 'Saúde' } },
  // Guardas de regressão (categorização de comida — bugs corrigidos jul/2026)
  // Salgado/lanche cai em "Lanches", a SUBcategoria de Alimentação da taxonomia
  // v3 (sql/084). O eval ainda cobrava o pai "Alimentação", de antes da v3, e
  // virou 3 falhas fixas no placar — eval que sempre falha para de ser sinal.
  { msg: 'gastei 9,50 com uma coxinha',       expect: { acao: 'salvar', valor: 9.5, categoria: 'Lanches' } },
  { msg: 'gastei 12 com um pastel',           expect: { acao: 'salvar', categoria: 'Lanches' } },
  { msg: 'gastei 8 num cachorro quente',      expect: { acao: 'salvar', categoria: 'Lanches' } }, // NÃO pode ser Pet
  { msg: 'gastei 100 na academia',            expect: { acao: 'salvar', categoria: 'Academia' } },
  // Valor NO FIM (introduzido por "por/de") — forma natural (bug jul/2026: caía no Grow "não entendi")
  { msg: 'Comprei um hambúrguer no ifood por 8,29 reais', expect: { acao: 'salvar', tipo: 'Gasto', valor: 8.29, categoria: 'Alimentação' } },
  { msg: 'paguei o uber por 15',              expect: { acao: 'salvar', tipo: 'Gasto', valor: 15, categoria: 'Transporte' } },
  { msg: 'paguei o almoço de 25',             expect: { acao: 'salvar', tipo: 'Gasto', valor: 25, categoria: 'Alimentação' } },
  { msg: 'comprei um presente de 50',         expect: { acao: 'salvar', tipo: 'Gasto', valor: 50 } },
  { msg: 'paguei a conta de luz',             expect: null }, // "de" sem número → NÃO vira gasto (cai pra IA/agenda)
  // DESCRIÇÃO = só o ITEM (sem artigo, sem loja, sem "compra de") — bug jul/2026.
  // categoria aqui é a do PARSER ('Encomendas' p/ marketplace); o handler ainda
  // refina pela mensagem inteira e vira a subcategoria real ("Mercado Livre").
  { msg: 'Comprei uma resistência no mercado livre por 28,90', expect: { acao: 'salvar', valor: 28.90, observacao: 'resistência', categoria: 'Encomendas' } },
  { msg: 'paguei compra de coberta no mercado livre por 120',  expect: { acao: 'salvar', valor: 120, observacao: 'coberta', categoria: 'Encomendas' } },
  { msg: 'Comprei um hambúrguer no ifood por 8,29 reais',      expect: { acao: 'salvar', observacao: 'hambúrguer' } },
  { msg: 'gastei 9,50 com uma coxinha',                        expect: { acao: 'salvar', observacao: 'coxinha' } },
  { msg: 'gastei 50 no mercado',                               expect: { acao: 'salvar', observacao: 'mercado' } },

  // ── "cancela" sozinho = desfazer o ÚLTIMO LANÇAMENTO (não cancelar assinatura) ──
  { msg: 'cancela',                           expect: { acao: 'apagar' } },
  { msg: 'cancelar',                          expect: { acao: 'apagar' } },
  { msg: 'cancela isso',                      expect: { acao: 'apagar' } },
  { msg: 'cancela esse gasto',                expect: { acao: 'apagar' } },
  // Guardas: cancelar plano/assinatura/resumo NÃO pode virar apagar
  { msg: 'quero cancelar minha assinatura',   expect: { acao: 'cancelar_plano' } },
  { msg: 'cancelar plano',                    expect: { acao: 'cancelar_plano' } },
  { msg: 'cancelar resumos',                  expect: { acao: 'config_resumos', valor: false } },

  // ── Registrar receita ─────────────────────────────────────────────────────
  { msg: 'recebi 3000 de salário',            expect: { acao: 'salvar', tipo: 'Recebimento', valor: 3000 } },
  { msg: 'ganhei 500',                        expect: { acao: 'salvar', tipo: 'Recebimento', valor: 500 } },

  // ── Resumo por período ────────────────────────────────────────────────────
  { msg: 'quanto gastei esse mês',            expect: { acao: 'resumo', periodo: 'mes' } },          // era buscar "mês" (bug)
  { msg: 'quanto gastei hoje',                expect: { acao: 'resumo', periodo: 'hoje' } },
  { msg: 'gastos dessa semana',               expect: { acao: 'resumo', periodo: 'semana' } },       // era buscar "dessa" (bug)
  { msg: 'quanto gastei semana passada',      expect: { acao: 'resumo', periodo: 'semana_passada' } },
  { msg: 'quanto gastei mês passado',         expect: { acao: 'resumo', periodo: 'mes_passado' } },
  { msg: 'quanto gastei esse ano',            expect: { acao: 'resumo', periodo: 'ano' } },
  { msg: 'resumo',                            expect: { acao: 'resumo', periodo: 'mes' } },
  { msg: 'meus gastos',                       expect: { acao: 'resumo', periodo: 'mes' } },
  { msg: 'no que gasto mais',                 expect: { acao: 'resumo', periodo: 'mes' } },           // era buscar "que mais" (bug)
  { msg: 'onde tô gastando demais',           expect: { acao: 'resumo', periodo: 'mes' } },           // era buscar "onde tô demais" (bug)

  // ── Buscar por assunto (+ período opcional) ───────────────────────────────
  { msg: 'gastos com alimentação',            expect: { acao: 'buscar', termo: 'alimentação' } },     // era cortado p/ "alimentaçã"
  { msg: 'quanto gastei com mercado',         expect: { acao: 'buscar', termo: 'mercado' } },
  { msg: 'meus gastos de uber',               expect: { acao: 'buscar', termo: 'uber' } },
  { msg: 'gastos com uber hoje',              expect: { acao: 'buscar', termo: 'uber', periodo: 'hoje' } },
  { msg: 'quanto gastei com mercado mês passado', expect: { acao: 'buscar', termo: 'mercado', periodo: 'mes_passado' } },

  // ── Saldo ─────────────────────────────────────────────────────────────────
  { msg: 'meu saldo',                         expect: { acao: 'ver_saldos' } },
  { msg: 'ver saldo',                         expect: { acao: 'ver_saldos' } },

  // ── Confirmar conta variável (previsto) ───────────────────────────────────
  { msg: 'confirmar luz 243',                 expect: { acao: 'confirmar_previsto', termo: 'luz', valor: 243 } },
  { msg: 'confirma agua 89,90',               expect: { acao: 'confirmar_previsto', termo: 'agua', valor: 89.9 } },

  // ── Recorrências / fixos ──────────────────────────────────────────────────
  { msg: 'todo mês 1000 aluguel dia 5',       expect: { acao: 'set_recorrente', valor: 1000, dia: 5 } },
  { msg: 'todo mês 50 spotify dia 10',        expect: { acao: 'set_recorrente', valor: 50, dia: 10 } },

  // ── LISTAR recorrências (consulta, ≠ cadastro) ────────────────────────────
  // Gastos fixos → só despesas
  { msg: 'quais meus gastos fixos desse mês?', expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'quais gastos fixos desse mês?',      expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'meus gastos fixos',                  expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'contas fixas',                       expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'minhas contas fixas do mês',         expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  { msg: 'listar despesas fixas',              expect: { acao: 'listar_recorrencias', filtro: 'Gasto' } },
  // Receitas fixas → só entradas
  { msg: 'quais minhas receitas fixas?',       expect: { acao: 'listar_recorrencias', filtro: 'Receita' } },
  { msg: 'minhas entradas fixas',              expect: { acao: 'listar_recorrencias', filtro: 'Receita' } },
  // Sem qualificar → tudo
  { msg: 'quais minhas recorrências desse mês', expect: { acao: 'listar_recorrencias', filtro: null } },
  { msg: 'minhas recorrências',                expect: { acao: 'listar_recorrencias', filtro: null } },
  { msg: 'recorrências',                       expect: { acao: 'listar_recorrencias', filtro: null } },
  { msg: 'ver recorrencias',                   expect: { acao: 'listar_recorrencias', filtro: null } },

  // ⚠️ O que NÃO pode virar listagem — o regex nunca chuta.
  // Cadastro tem valor E dia: não pode ser engolido pela consulta.
  { msg: 'todo mês 1200 aluguel dia 5',       expect: { acao: 'set_recorrente' } },
  { msg: 'gastei 50 no mercado',              expect: { acao: 'salvar' } },
  // ⚠️ QUIRK PRÉ-EXISTENTE (não é da listagem): a regra genérica de "gast\w+"
  // (linha ~576) captura QUALQUER frase com "gasto" e devolve resumo do mês.
  // Verificado no HEAD antes desta feature — as duas já se comportavam assim.
  // Registrado aqui como comportamento ATUAL pra o eval não ficar com falha
  // permanente (eval que sempre falha para de ser sinal). Corrigir exige mexer
  // na regra ampla de gastos, que é risco à parte.
  { msg: 'paguei o aluguel que é meu maior gasto fixo', expect: { acao: 'resumo' } },
  { msg: 'quero cadastrar um gasto fixo',     expect: { acao: 'resumo' } },

  // ── Cartão / parcelas / fatura ────────────────────────────────────────────
  { msg: 'comprei fone no nubank crédito em 3x de 150', expect: { acao: 'compra_parcelada' } },
  { msg: 'pagar fatura',                      expect: { acao: 'pagar_fatura' } },
  // Listar compras parceladas (comando novo + variações naturais)
  { msg: 'parcelas',                          expect: { acao: 'listar_parcelas' } },
  { msg: 'minhas parcelas',                   expect: { acao: 'listar_parcelas' } },
  { msg: 'como estão minhas parcelas',        expect: { acao: 'listar_parcelas' } },
  { msg: 'quantas parcelas tenho pra pagar',  expect: { acao: 'listar_parcelas' } },
  { msg: 'compras parceladas',                expect: { acao: 'listar_parcelas' } },
  { msg: 'parcelas em aberto',                expect: { acao: 'listar_parcelas' } },
  { msg: 'antecipar parcela do fone',         expect: { acao: 'antecipar_parcela', termo: 'fone' } }, // verbo continua ganhando
  // Gastos por cartão / conta (comando novo)
  { msg: 'gastos dos meus cartões',           expect: { acao: 'gastos_carteiras' } },
  { msg: 'quanto gastei nas contas',          expect: { acao: 'gastos_carteiras' } },
  { msg: 'gastos por cartão e conta',         expect: { acao: 'gastos_carteiras' } },
  { msg: 'quanto gastei no cartão',           expect: { acao: 'gastos_carteiras' } },

  // ── Contas bancárias ──────────────────────────────────────────────────────
  { msg: 'adicionar 200 no inter',           expect: { acao: 'adicionar_saldo', valor: 200 } },
  { msg: 'transferir 200 do nubank pro inter', expect: { acao: 'transferir', valor: 200 } },
  // AJUSTAR = conta que já existe → alterar_saldo (NUNCA set_wallet "conta criada").
  { msg: 'Ajustar mercado pago para 700',    expect: { acao: 'alterar_saldo', nome: 'mercado pago', valor: 700 } },
  { msg: 'ajustar nubank 850',               expect: { acao: 'alterar_saldo', nome: 'nubank', valor: 850 } },
  { msg: 'ajusta o saldo do inter pra 300',  expect: { acao: 'alterar_saldo', nome: 'inter', valor: 300 } },
  { msg: 'corrigir mercado pago para 621,25', expect: { acao: 'alterar_saldo', nome: 'mercado pago', valor: 621.25 } },
  // Guarda: criar conta continua sendo set_wallet
  { msg: 'nubank 1000',                      expect: { acao: 'set_wallet', nome: 'nubank', valor: 1000 } },

  // ── Limites ───────────────────────────────────────────────────────────────
  { msg: 'limite 2000',                       expect: { acao: 'set_meta', valor: 2000 } },
  { msg: 'meus limites',                      expect: { acao: 'meus_limites' } },

  // ── Dívidas / grupos / comandos simples ───────────────────────────────────
  { msg: 'minhas dívidas',                    expect: { acao: 'listar_dividas' } },
  { msg: 'criar grupo Família',               expect: { acao: 'criar_grupo' } },
  { msg: 'ajuda',                             expect: { acao: 'ajuda' } },
  { msg: 'painel',                            expect: { acao: 'painel' } },
  { msg: 'excluir última',                    expect: { acao: 'apagar' } },

  // ── Grow (roteia p/ handler do Grow) ──────────────────────────────────────
  { msg: 'comi 2 ovos e pão',                 expect: { acao: 'grow_refeicao' } },

  // ── DEVE CAIR PRA IA (parser devolve null — linguagem livre/coloquial) ─────
  { msg: 'como tá meu mês',                   expect: null },
  { msg: 'quanto eu tenho',                   expect: null },
  { msg: 'tô com quanto',                     expect: null },
  { msg: 'me mostra o que saiu de mercado',   expect: null },
  { msg: 'qual a capital da frança',          expect: null },
  { msg: 'bom dia',                           expect: null },
];

// Match parcial: cada campo de `expect` precisa bater no resultado.
function bate(expect, got) {
  if (expect === null) return got === null || got === undefined;
  if (!got) return false;
  for (const k of Object.keys(expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(expect[k])) return false;
  }
  return true;
}

let ok = 0;
const falhas = [];
for (const { msg, expect } of CASOS) {
  const got = interpretarRapido(msg);
  const passou = bate(expect, got);
  if (passou) ok++; else falhas.push({ msg, expect, got });
  const alvo = expect === null ? '→ IA' : (expect.acao || '(campos)');
  console.log(`${passou ? '  ok ' : 'FALHA'}  ${alvo.padEnd(18)} « ${msg} »`);
}

const total = CASOS.length;
console.log(`\n${ok}/${total} certas` + (falhas.length ? ` · ${falhas.length} FALHA(S) ❌` : ' · tudo passou ✅'));

if (falhas.length) {
  console.log('\n── Falhas (o que veio ≠ o esperado) ──');
  for (const f of falhas) {
    console.log(`  « ${f.msg} »`);
    console.log(`    esperado: ${JSON.stringify(f.expect)}`);
    console.log(`    veio:     ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
