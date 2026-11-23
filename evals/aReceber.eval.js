// =============================================================================
// "Quanto eu tenho a receber ainda este mês?" — services/aReceberPeriodo.js.
//
//   §1 o detector pega as formas de perguntar e NUNCA lançamento/relato/lembrete;
//   §2 os comandos vizinhos seguem no destino de antes (a pagar, receitas fixas,
//      lançar receita, resumos) — passando pelo interpretador inteiro;
//   §3 o que entra: receita fixa não recebida + entrada prevista; o que já foi
//      recebido, pulado, transferência, ajuste, cartão e "não considerar" fica fora;
//   §4 o texto: total, sem valor fora do total, vazio explicado;
//   §5 o caso do relato (13º previsto pra 30/11), com os dados como estão.
//
// Rodar: node evals/aReceber.eval.js
// =============================================================================
const { interpretarRapido } = require('../src/handlers/interpretador');
const R = require('../src/services/aReceberPeriodo');

const falhas = [];
let total = 0;
const ok = (c, msg) => { total += 1; if (!c) falhas.push(msg); };
const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

// ── §1 DETECTOR ──────────────────────────────────────────────────────────────
const SIM = {
  'quanto eu tenho a receber ainda no mês atual': 'mes',          // a frase do relato
  'Quanto eu tenho a receber ainda no mês atual?': 'mes',
  'quanto tenho a receber esse mês?': 'mes',
  'o que tenho pra receber esse mês': 'mes',
  'quanto ainda vou receber esse mês': 'mes',
  'quanto falta receber no mês?': 'mes',
  'quanto tenho a receber': 'mes',                               // sem período: o resto do mês
  'o que tenho pra receber hoje?': 'hoje',
  'tenho algo pra receber amanhã?': 'amanha',
  'quanto vou receber essa semana': 'semana',
  'quanto tenho a receber mês que vem?': 'proximo_mes',
  'quanto vou receber nos próximos 15 dias': 'dias',
  'valores a receber': 'mes',
  'quais entradas tenho pra receber esse mês?': 'mes',
};
for (const [frase, tipo] of Object.entries(SIM)) {
  const r = R.detectarAReceber(frase);
  ok(r && r.acao === 'a_receber' && r.periodo.tipo === tipo, `§1 "${frase}" → a_receber/${tipo} (veio ${JSON.stringify(r)})`);
}
ok(R.detectarAReceber('quanto vou receber nos próximos 15 dias').periodo.n === 15, '§1 "próximos 15 dias" guarda o 15');

const NAO = [
  'recebi 500 do joão',                       // lançamento
  'recebi o salário hoje',                    // relato
  'já recebi o vale',
  'quanto recebi esse mês?',                  // passado = resumo, não "a receber"
  'o que eu recebo todo mês',                 // lista de receitas FIXAS (não casa aqui)
  'o que eu tenho a receber todo mês?',       // idem, com "receber"
  'quais minhas receitas fixas?',
  'não quero mais receber os resumos',        // configuração do zap
  'quero receber o resumo semanal',
  'quando vou receber os lembretes?',
  'lembrar receber aluguel dia 10/12 valor 500', // lembrete com valor
  'vou receber 300 amanhã',                   // valor na frase
  'quanto tenho a receber de 1000?',
  'o que tenho pra pagar esse mês',           // é do a_pagar
  // Relato + pergunta na mesma frase é ambíguo (pode ser pra REGISTRAR o que
  // recebeu): vai pra IA, como o "paguei … o que falta pagar" do a_pagar.
  'já recebi o salário, o que falta receber esse mês?',
  '',
];
// (Nota: somar um item SEM valor no total é inofensivo — `null` soma 0 — por
// isso a mutação que tira o `continue` desse ramo é equivalente.)
for (const frase of NAO) ok(R.detectarAReceber(frase) === null, `§1 "${frase}" NÃO é a_receber (veio ${JSON.stringify(R.detectarAReceber(frase))})`);

// ── §2 VIZINHOS NO INTERPRETADOR INTEIRO ─────────────────────────────────────
const destino = (f) => { const r = interpretarRapido(f); return r ? r.acao + (r.filtro !== undefined ? `/${r.filtro}` : '') : null; };
const VIZINHOS = {
  'quanto eu tenho a receber ainda no mês atual': 'a_receber',
  'o que tenho pra pagar esse mês': 'a_pagar',
  'o que falta pagar esse mês': 'a_pagar',
  'quais contas vencem essa semana': 'a_pagar',
  'quais minhas receitas fixas?': 'listar_recorrencias/Receita',
  'minhas entradas fixas': 'listar_recorrencias/Receita',
  'quais meus gastos fixos?': 'listar_recorrencias/Gasto',
  'minhas contas fixas do mês': 'listar_recorrencias/Gasto',
  'quais minhas recorrências?': 'listar_recorrencias/null',
};
for (const [f, esperado] of Object.entries(VIZINHOS)) ok(destino(f) === esperado, `§2 "${f}" → ${esperado} (veio ${destino(f)})`);
// O que a Central de comandos ANUNCIA pra este comando tem de chegar nele.
{
  const fs = require('fs'); const path = require('path');
  const arq = path.join(__dirname, '../../sora-frontend/lib/sora-commands.ts');
  if (!fs.existsSync(arq)) console.warn('⚠️  sora-frontend/lib/sora-commands.ts não encontrado — conferência da Central pulada');
  else {
    const bloco = (fs.readFileSync(arq, 'utf8').match(/id:\s*'a-receber-periodo'[\s\S]*?categoria:/) || [''])[0];
    const anunciadas = [...bloco.matchAll(/'([^']*\?)'/g)].map((m) => m[1]);
    ok(anunciadas.length >= 3, `§2 a Central anuncia o comando (${anunciadas.length} frases)`);
    for (const f of anunciadas) ok(destino(f) === 'a_receber', `§2 frase da Central "${f}" → a_receber (veio ${destino(f)})`);
  }
}
// Lançamento de receita continua sendo lançamento.
const lanc = interpretarRapido('recebi 500 de salário');
ok(lanc && lanc.acao !== 'a_receber', `§2 "recebi 500 de salário" segue lançamento (veio ${JSON.stringify(lanc)})`);

// ── §3 MONTAR ────────────────────────────────────────────────────────────────
const HOJE = '2026-11-23';
const JANELA = R.janelaAReceber({ tipo: 'mes' }, HOJE);
ok(JANELA.de === '2026-11-23' && JANELA.ate === '2026-11-30', `§3 janela = hoje → fim do mês (veio ${JANELA.de}..${JANELA.ate})`);
const rec = (id, dia, valor, extra = {}) => ({ id, tipo: 'Recebimento', descricao: id, valor, dia_vencimento: dia, frequencia: 'mensal', data_inicio: '2026-01-01', ativa: true, ...extra });
const pend = (data, valor, extra = {}) => ({ tipo: 'Recebimento', valor, data, pago: false, categoria: 'Outros', observacao: 'Entrada', ...extra });

const montar = (dados) => R.montarItensReceber({ recorrencias: [], vinculadas: [], ajustes: [], pendentes: [], ...dados }, JANELA);
let itens = montar({ recorrencias: [rec('Freela', 25, 800)] });
ok(itens.length === 1 && itens[0].descricao === 'Freela' && itens[0].valor === 800 && itens[0].data === '2026-11-25', '§3 receita fixa ainda não recebida entra');
ok(montar({ recorrencias: [rec('Freela', 25, 800)], vinculadas: [{ recorrencia_id: 'Freela', competencia: '2026-11' }] }).length === 0, '§3 já recebida no mês (baixa) NÃO entra');
ok(montar({ recorrencias: [rec('Freela', 25, 800)], ajustes: [{ recorrencia_id: 'Freela', competencia: '2026-11', status: 'pulado' }] }).length === 0, '§3 pulada NÃO entra');
itens = montar({ recorrencias: [rec('Freela', 21, 800)], ajustes: [{ recorrencia_id: 'Freela', competencia: '2026-11', status: 'movido', nova_data: '2026-11-28' }] });
ok(itens.length === 1 && itens[0].data === '2026-11-28' && itens[0].detalhe === 'adiada', '§3 adiada aparece na data nova');
itens = montar({ recorrencias: [rec('Freela', 25, 800)], ajustes: [{ recorrencia_id: 'Freela', competencia: '2026-11', status: 'valor', novo_valor: 650 }] });
ok(itens.length === 1 && itens[0].valor === 650, '§3 valor ajustado no Extrato vale pra esta ocorrência');
ok(montar({ recorrencias: [rec('Salario', 7, 2151)] }).length === 0, '§3 receita fixa de dia que já passou não entra (a janela começa hoje)');
ok(montar({ recorrencias: [{ ...rec('Aluguel', 25, 1000), tipo: 'Gasto' }] }).length === 0, '§3 GASTO fixo nunca entra');
itens = montar({ recorrencias: [rec('Comissao', 26, 0, { valor_variavel: true })] });
ok(itens.length === 1 && itens[0].valor === null, '§3 receita de valor variável sem estimativa entra sem valor');
// Lançada como pendente (cron) + baixa amarrada: entra UMA vez, pela transação.
itens = montar({
  recorrencias: [rec('Freela', 25, 800)],
  vinculadas: [{ recorrencia_id: 'Freela', competencia: '2026-11' }],
  pendentes: [pend('2026-11-25', 820, { observacao: '[Previsto] Freela' })],
});
ok(itens.length === 1 && itens[0].origem === 'prevista' && itens[0].valor === 820 && itens[0].descricao === 'Freela', '§3 receita fixa lançada como pendente entra uma vez só');

ok(montar({ pendentes: [pend('2026-11-30', 1633.33)] }).length === 1, '§3 entrada prevista no período entra');
ok(montar({ pendentes: [pend('2026-11-30', 100, { pago: true })] }).length === 0, '§3 já recebida NÃO entra');
ok(montar({ pendentes: [pend('2026-11-30', 100, { transferencia: true })] }).length === 0, '§3 transferência entre contas NÃO entra');
ok(montar({ pendentes: [pend('2026-11-30', 100, { categoria: '🏦 Ajuste' })] }).length === 0, '§3 ajuste de saldo NÃO entra');
ok(montar({ pendentes: [pend('2026-11-30', 100, { categoria: 'Transferências' })] }).length === 0, '§3 categoria Transferências NÃO entra');
ok(montar({ pendentes: [pend('2026-11-30', 100, { ignorar_em: 'tudo' })] }).length === 0, '§3 "não considerar" NÃO entra');
ok(montar({ pendentes: [pend('2026-12-05', 100)] }).length === 0, '§3 fora do período NÃO entra');
ok(montar({ pendentes: [pend('2026-11-22', 100)] }).length === 0, '§3 antes de hoje NÃO entra');
ok(montar({ pendentes: [{ ...pend('2026-11-30', 100), tipo: 'Gasto' }] }).length === 0, '§3 gasto pendente NÃO entra');
// Data pura (meia-noite UTC) é o próprio dia; instante às 01h UTC é o dia anterior em SP.
ok(montar({ pendentes: [pend('2026-11-30T00:00:00+00:00', 50)] })[0]?.data === '2026-11-30', '§3 data pura é o próprio dia');
ok(montar({ pendentes: [pend('2026-12-01T01:00:00+00:00', 50)] })[0]?.data === '2026-11-30', '§3 01h UTC de 01/12 é 30/11 em SP');
// Ordem por data.
itens = montar({ recorrencias: [rec('B', 28, 10)], pendentes: [pend('2026-11-24', 20, { observacao: 'A' })] });
ok(itens.map((i) => i.descricao).join(',') === 'A,B', '§3 ordenado por data');

// ── §4 TEXTO ─────────────────────────────────────────────────────────────────
const vazio = R.formatarAReceber([], JANELA, { fmt, hoje: HOJE });
ok(/Nada pra receber este mês/.test(vazio) && /receitas fixas/.test(vazio), '§4 vazio explica o que foi olhado');
const txt = R.formatarAReceber([
  { data: '2026-11-25', descricao: 'Freela', origem: 'fixa', valor: 800 },
  { data: '2026-11-30', descricao: '13º', origem: 'prevista', valor: 1633.33 },
  { data: '2026-11-30', descricao: 'Comissão', origem: 'fixa', valor: null, variavel: true },
], JANELA, { fmt, hoje: HOJE });
ok(/Total: R\$ 2433,33\* · 3 entradas/.test(txt), `§4 total soma só o que tem valor (veio: ${txt.split('\n').filter((l) => /Total/.test(l))})`);
ok(/1 sem valor definido/.test(txt) && /valor a confirmar/.test(txt), '§4 sem valor fica fora do total e é dito');
ok(/Pra receber este mês \(23\/11 a 30\/11\)/.test(txt), '§4 título com o período');
ok(/\*Seg · 30\/11\*/.test(txt) && /\*Qua · 25\/11\*/.test(txt), '§4 agrupado por dia, com dia da semana');
ok(/_\(fixa\)_/.test(txt), '§4 receita fixa identificada');

// ── §5 O CASO DO RELATO (dados como estão na conta, hoje 23/11) ──────────────
const fabio = {
  recorrencias: [
    { id: 'sal', tipo: 'Recebimento', descricao: 'Salário', valor: 2151, dia_vencimento: 7, frequencia: 'mensal', data_inicio: '2026-09-18', ativa: true },
    { id: 'vale', tipo: 'Recebimento', descricao: 'Vale do Salário', valor: 1960, dia_vencimento: 20, frequencia: 'mensal', data_inicio: '2026-09-15', ativa: true },
  ],
  vinculadas: [{ recorrencia_id: 'sal', competencia: '2026-11' }, { recorrencia_id: 'vale', competencia: '2026-11' }],
  ajustes: [],
  pendentes: [
    { tipo: 'Recebimento', valor: 1633.33, data: '2026-11-30', pago: false, categoria: '🎄 13º salário', observacao: '1° Parcela do Décimo Terceiro ' },
    { tipo: 'Recebimento', valor: 1336.23, data: '2026-12-20', pago: false, categoria: '🎄 13º salário', observacao: '2° Parcela do Décimo Terceiro ' },
  ],
};
itens = R.montarItensReceber(fabio, JANELA);
ok(itens.length === 1 && itens[0].descricao === '1° Parcela do Décimo Terceiro' && itens[0].valor === 1633.33, `§5 este mês: só a 1ª parcela do 13º (veio ${JSON.stringify(itens)})`);
const texto = R.formatarAReceber(itens, JANELA, { fmt, hoje: HOJE });
ok(/Total: R\$ 1633,33/.test(texto), '§5 total = R$ 1.633,33 (o "Ainda entra" do painel)');
itens = R.montarItensReceber(fabio, R.janelaAReceber({ tipo: 'proximo_mes' }, HOJE));
ok(itens.map((i) => i.descricao).join(' | ') === 'Salário | Vale do Salário | 2° Parcela do Décimo Terceiro', `§5 mês que vem: salário, vale e a 2ª parcela (veio ${itens.map((i) => i.descricao)})`);

if (falhas.length) {
  console.error(`\n❌ ${falhas.length} de ${total} falharam:`);
  for (const f of falhas) console.error('  ·', f);
  process.exit(1);
}
console.log(`✅ a receber: ${total} verificações ok`);
