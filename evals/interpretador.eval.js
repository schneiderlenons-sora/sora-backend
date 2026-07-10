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
  // ── Registrar gasto (salvar) ──────────────────────────────────────────────
  { msg: 'gastei 50 no mercado',              expect: { acao: 'salvar', tipo: 'Gasto', valor: 50, categoria: 'Mercado' } },
  { msg: 'paguei 30 no uber',                 expect: { acao: 'salvar', tipo: 'Gasto', valor: 30, categoria: 'Transporte' } },
  { msg: 'gastei 200 na farmacia',            expect: { acao: 'salvar', tipo: 'Gasto', categoria: 'Saúde' } },
  // Guardas de regressão (categorização de comida — bugs corrigidos jul/2026)
  { msg: 'gastei 9,50 com uma coxinha',       expect: { acao: 'salvar', valor: 9.5, categoria: 'Alimentação' } },
  { msg: 'gastei 12 com um pastel',           expect: { acao: 'salvar', categoria: 'Alimentação' } },
  { msg: 'gastei 8 num cachorro quente',      expect: { acao: 'salvar', categoria: 'Alimentação' } }, // NÃO pode ser Pet
  { msg: 'gastei 100 na academia',            expect: { acao: 'salvar', categoria: 'Academia' } },

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

  // ── Cartão / parcelas / fatura ────────────────────────────────────────────
  { msg: 'comprei fone no nubank crédito em 3x de 150', expect: { acao: 'compra_parcelada' } },
  { msg: 'pagar fatura',                      expect: { acao: 'pagar_fatura' } },

  // ── Contas bancárias ──────────────────────────────────────────────────────
  { msg: 'adicionar 200 no inter',           expect: { acao: 'adicionar_saldo', valor: 200 } },
  { msg: 'transferir 200 do nubank pro inter', expect: { acao: 'transferir', valor: 200 } },

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
  const alvo = expect === null ? '→ IA' : expect.acao;
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
