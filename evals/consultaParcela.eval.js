// =============================================================================
// EVAL — consultar UMA compra parcelada ("parcelas do presente da Juliana").
//
// Um cliente pediu pelo WhatsApp "me mostre o valor e quantidade de parcelas
// do presente da Juliana" e não conseguiu: a regra local só conhecia "quantas
// parcelas", a IA não tinha o comando, e `listar_parcelas` não filtrava.
//
// ⚠️ O que este eval protege, além do caso do cliente: a consulta NUNCA pode
// sequestrar registro/pagamento ("paguei a parcela do carro") nem mudar o que
// "minhas parcelas" faz hoje (listar todas).
//
// Rodar:  npm run eval:consulta-parcela
// =============================================================================
const { extrairTermoParcela, termoCasaCompra, diaSP, parcelaJaCobrada, agruparParcelas,
        rotuloParcela } = require('../src/services/consultaParcela');
const { interpretarRapido } = require('../src/handlers/interpretador');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

console.log('── 1. o caso do cliente ──');
{
  const frase = 'Sora, me mostre o valor e quantidade de parcelas do presente da Juliana';
  const r = interpretarRapido(frase);
  ok(r && r.acao === 'listar_parcelas', `vira listar_parcelas (veio ${JSON.stringify(r)})`);
  ok(r && /presente da juliana/i.test(r.termo || ''), `com o termo da compra (veio ${JSON.stringify(r && r.termo)})`);
  // A compra real dele: "Presente Juliana" no Mercado Pago Crédito.
  ok(termoCasaCompra(r && r.termo, 'Presente Juliana', 'Mercado Pago Crédito'), 'o termo casa a compra real');
  // ⚠️ E NÃO casa a outra compra de presente dele, de outra pessoa.
  ok(!termoCasaCompra(r && r.termo, 'presente Jamille', 'Mercado Pago Crédito'), 'não traz o presente da Jamille');
}
console.log('  ok');

console.log('── 2. jeitos naturais de perguntar uma compra ──');
const CASOS = [
  ['quantas parcelas faltam do celular', 'celular'],
  ['quantas parcelas faltam pro notebook', 'notebook'],
  ['valor da parcela do celular', 'celular'],
  ['detalhes da compra parcelada do fone', 'fone'],
  ['quero ver as parcelas do presente', 'presente'],
  ['parcelas do nubank', 'nubank'],
  ['quanto é a parcela do meu carro', 'carro'],
  ['a parcela da tv vence quando', 'tv'],
];
for (const [frase, esperado] of CASOS) {
  const t = extrairTermoParcela(frase);
  ok(t.toLowerCase() === esperado, `"${frase}" → termo "${esperado}" (veio "${t}")`);
}
console.log('  ok');

console.log('── 3. ⚠️ NÃO sequestra registro nem pagamento ──');
for (const frase of [
  'paguei a parcela do carro',
  'comprei um celular parcelado do mercado livre',
  'parcelei o notebook com joão',
  'antecipar parcela do fone',
  'quitar parcelas da tv',
  'gastei 50 na parcela do curso',
]) ok(extrairTermoParcela(frase) === '', `"${frase}" não é consulta`);
console.log('  ok');

console.log('── 4. ⚠️ "listar todas" continua exatamente igual ──');
for (const frase of [
  'parcelas', 'minhas parcelas', 'como estão minhas parcelas', 'quantas parcelas tenho pra pagar',
  'compras parceladas', 'parcelas em aberto', 'parcelas a pagar', 'parcelas pendentes',
]) {
  ok(extrairTermoParcela(frase) === '', `"${frase}" não extrai termo`);
  const r = interpretarRapido(frase);
  ok(r && r.acao === 'listar_parcelas' && r.termo === undefined, `"${frase}" segue listando TODAS (veio ${JSON.stringify(r)})`);
}
// Termo que não nomeia compra: continua como antes (sem filtro).
for (const frase of ['parcelas do cartão', 'parcelas da fatura', 'parcelas do mês']) {
  ok(extrairTermoParcela(frase) === '', `"${frase}" não vira filtro`);
}
console.log('  ok');

console.log('── 5. casamento da compra ──');
ok(termoCasaCompra('celular', 'Celular Samsung', 'Nubank Crédito'), 'palavra da descrição');
ok(termoCasaCompra('nubank', 'Celular Samsung', 'Nubank Crédito'), 'nome do cartão também vale');
ok(termoCasaCompra('presente nubank', 'Presente', 'Nubank Crédito'), 'descrição + cartão juntos');
ok(termoCasaCompra('presentes', 'Presente Juliana', 'MP'), 'plural casa singular');
ok(termoCasaCompra('geladeira', 'Geladeira Brastemp', null), 'cartão ausente não quebra');
ok(termoCasaCompra('CELULAR', 'celular', 'x'), 'sem diferença de caixa');
ok(termoCasaCompra('cafe', 'Café Especial', 'x'), 'sem diferença de acento');
ok(!termoCasaCompra('celular iphone', 'Celular Samsung', 'Nubank'), 'TODAS as palavras têm de aparecer');
ok(!termoCasaCompra('tv', 'Notebook', 'Nubank'), 'nada a ver não casa');
ok(!termoCasaCompra('', 'Notebook', 'Nubank'), 'termo vazio não casa nada');
console.log('  ok');

// ── 6. ⚠️ PARCELA COBRADA NÃO É "A PAGAR" ────────────────────────────────
//
// O relato: "parcelas" listou JIM.COM PROSED ES como a pagar com as duas
// parcelas cobradas. A 2/2 foi importada em agosto, quando 03/09 era futuro —
// nasceu `pago: false` e nada a virou quando o dia chegou. Linhas REAIS da
// conta, lidas do banco em 14/09/2026.
console.log('── 6. parcela cujo dia chegou já foi cobrada ──');
{
  const HOJE = '2026-09-14';
  const REAIS = [
    { valor: 79.86, observacao: 'JIM.COM PROSED ES', carteira_nome: 'Mercado Pago (OF)', pago: false,
      data: '2026-09-03T12:00:00+00:00', parcela_num: 2, parcela_total: 2, parcela_grupo: 'OF76BB6461E6' },
    { valor: 33.30, observacao: 'AMAZON BR', carteira_nome: 'Mercado Pago (OF)', pago: true,
      data: '2026-09-12T12:00:00+00:00', parcela_num: 1, parcela_total: 2, parcela_grupo: 'OFAMZ' },
    { valor: 33.30, observacao: 'AMAZON BR', carteira_nome: 'Mercado Pago (OF)', pago: false,
      data: '2026-10-12T12:00:00+00:00', parcela_num: 2, parcela_total: 2, parcela_grupo: 'OFAMZ' },
  ];
  const g = agruparParcelas(REAIS, [], HOJE);
  const jim = g.get('OF76BB6461E6');
  ok(jim.restantes === 0, `JIM: nada a vencer (veio ${jim.restantes})`);
  // ⚠️ A 1/2 veio SEM marcador e não está no grupo: sem `total − restantes`
  // a tela diria "1 de 2".
  ok(jim.pagas === 2, `JIM: 2 de 2 cobradas, mesmo com a 1/2 fora do grupo (veio ${jim.pagas})`);
  ok(jim.valorTotal === 159.72, `JIM: total estimado das 2 parcelas (veio ${jim.valorTotal})`);
  const amz = g.get('OFAMZ');
  ok(amz.restantes === 1 && amz.pagas === 1, `AMAZON segue com 1 a vencer (veio ${amz.pagas}/${amz.restantes})`);
  ok(amz.valorRestante === 33.3, `AMAZON: R$ 33,30 a pagar (veio ${amz.valorRestante})`);
  ok(String(amz.proxima && amz.proxima.data).startsWith('2026-10-12'), 'AMAZON: próxima em 12/10');
  const abertas = [...g.values()].filter((x) => x.restantes > 0);
  ok(abertas.length === 1, `a lista "parcelas" mostra só a AMAZON (veio ${abertas.length})`);
}
{
  const HOJE = '2026-09-14';
  // ⚠️ ANTECIPADA: paga com data futura. Tem de continuar cobrada.
  ok(parcelaJaCobrada({ pago: true, data: '2026-12-10' }, HOJE), 'antecipada (paga, data futura) conta como cobrada');
  ok(!parcelaJaCobrada({ pago: false, data: '2026-12-10' }, HOJE), 'futura e não paga está a vencer');
  ok(parcelaJaCobrada({ pago: false, data: '2026-09-14' }, HOJE), 'a do DIA de hoje já foi cobrada');
  ok(!parcelaJaCobrada({ pago: false, data: null }, HOJE), 'sem data não inventa cobrança');
  // ⚠️ Fuso: instante 01:30 UTC do dia 15 ainda é dia 14 em São Paulo;
  // data pura (meia-noite UTC) do dia 15 é dia 15.
  ok(diaSP('2026-09-15T01:30:00+00:00') === '2026-09-14', 'instante real vira o dia de São Paulo');
  ok(diaSP('2026-09-15T00:00:00+00:00') === '2026-09-15', 'meia-noite UTC é data pura: não volta um dia');
  ok(diaSP('2026-09-15') === '2026-09-15', 'data sem hora fica como está');
  ok(parcelaJaCobrada({ pago: false, data: '2026-09-15T01:30:00+00:00' }, HOJE), '21h30 do dia 14 em SP já é cobrada no dia 14');
  ok(!parcelaJaCobrada({ pago: false, data: '2026-09-15T00:00:00+00:00' }, HOJE), 'data pura de amanhã ainda está a vencer');
}
{
  const HOJE = '2026-09-14';
  // Manual, 3x no painel: 1ª paga, 2ª já passou sem ninguém marcar, 3ª futura.
  const manual = [
    { valor: 100, observacao: 'Geladeira', carteira_nome: 'Nubank Crédito', pago: true, data: '2026-08-10', parcela_total: 3, parcela_grupo: 'M1' },
    { valor: 100, observacao: 'Geladeira', carteira_nome: 'Nubank Crédito', pago: false, data: '2026-09-10', parcela_total: 3, parcela_grupo: 'M1' },
    { valor: 100, observacao: 'Geladeira', carteira_nome: 'Nubank Crédito', pago: false, data: '2026-10-10', parcela_total: 3, parcela_grupo: 'M1' },
  ];
  const m = agruparParcelas(manual, [], HOJE).get('M1');
  ok(m.pagas === 2 && m.restantes === 1, `manual: 2 cobradas, 1 a vencer (veio ${m.pagas}/${m.restantes})`);
  ok(m.valorTotal === 300 && m.valorRestante === 100, `manual: total 300, a pagar 100 (veio ${m.valorTotal}/${m.valorRestante})`);

  // Legado "Desc (n/m)": o banco só devolve as NÃO pagas.
  const legado = [
    { valor: 50, observacao: 'Fone (2/3)', carteira_nome: 'Inter', pago: false, data: '2026-09-01' },
    { valor: 50, observacao: 'Fone (3/3)', carteira_nome: 'Inter', pago: false, data: '2026-10-01' },
  ];
  const l = [...agruparParcelas([], legado, HOJE).values()][0];
  ok(l.legado && l.total === 3, 'legado agrupa pelo total do marcador');
  ok(l.restantes === 1 && l.pagas === 2, `legado: 2/3 cobradas, 1 a vencer (antes "0/3 pagas") (veio ${l.pagas}/${l.restantes})`);
  ok(l.valorTotal === 150, `legado: total = 3 × 50 (veio ${l.valorTotal})`);
  ok(String(l.proxima.data) === '2026-10-01', 'legado: a próxima é a futura, não a que já passou');

  // Sem total conhecido: conta o que tem.
  const semTotal = agruparParcelas([
    { valor: 10, observacao: 'X', pago: true, data: '2026-08-01', parcela_grupo: 'S' },
    { valor: 10, observacao: 'X', pago: false, data: '2026-11-01', parcela_grupo: 'S' },
  ], [], HOJE).get('S');
  ok(semTotal.total === 0 && semTotal.pagas === 1 && semTotal.restantes === 1, 'sem parcela_total: pagas = linhas cobradas');

  // ⚠️ Nunca AUMENTA o que falta em relação à regra antiga (só `pago`).
  const antigoRestantes = manual.filter((t) => !t.pago).length;
  ok(m.restantes <= antigoRestantes, 'a regra nova só tira parcela da lista, nunca põe');
}
console.log('  ok');

// ── 7. "QUAL PARCELA É ESSA?" NA LISTA DA FATURA ───────────────────────────
//
// Pedido de cliente (set/2026), logo depois de o relatório de fatura entrar no
// ar: "ficaria melhor se as compras que são parceladas mostrassem qual parcela
// é aquele mês". Os campos já vinham estruturados; a lista é que não os lia.
console.log('── 7. rótulo de parcela na lista ──');
{
  // Este eval só tem `ok`; o `eq` local dá a mensagem com esperado × recebido.
  const eq = (a, b, m) => ok(a === b, m + ' (esperado ' + JSON.stringify(b) + ', veio ' + JSON.stringify(a) + ')');
  const r = (tx, desc) => rotuloParcela(tx, desc);

  eq(r({ parcela_num: 3, parcela_total: 9 }, 'Samsung S25'), ' · 3/9', 'parcelada mostra N/M');
  eq(r({ parcela_num: 1, parcela_total: 12 }, 'Notebook'),   ' · 1/12', 'primeira parcela também');
  eq(r({ parcela_num: 12, parcela_total: 12 }, 'Notebook'),  ' · 12/12', 'última parcela também');

  // ⚠️ O CASO QUE EVITA RUÍDO EM 8 DE CADA 10 LINHAS. Compra à vista chega ora
  // como 1/1, ora como null (medido: 82 × 8.632 desde 01/08). Rotular "(1/1)"
  // em cada compra normal encheria a fatura de informação inútil.
  eq(r({ parcela_num: 1, parcela_total: 1 }, 'Mercado'), '', 'à vista marcada 1/1 não rotula');
  eq(r({ parcela_num: null, parcela_total: null }, 'Padaria'), '', 'sem os campos não rotula');
  eq(r({}, 'Padaria'), '', 'objeto vazio não rotula');
  eq(r(null, 'Padaria'), '', 'tx null não quebra');

  // ⚠️ NÃO REPETE O QUE JÁ ESTÁ NO TEXTO. Parte das descrições vem do banco com
  // o marcador colado (medido: 69 na amostra) — sem isto a linha sairia
  // "HOTEIS.COM 12/12 · 12/12".
  eq(r({ parcela_num: 12, parcela_total: 12 }, 'HOTEIS.COM 12/12'), '', 'não duplica o marcador do banco');
  eq(r({ parcela_num: 2, parcela_total: 3 }, 'CHINOCA 2 / 3'), '', 'ignora espaço no marcador do banco');
  // Mas um número PARECIDO que não é o marcador não pode suprimir o rótulo.
  eq(r({ parcela_num: 2, parcela_total: 3 }, 'PNEU 205/55'), ' · 2/3', 'número diferente não suprime');

  // Texto em número (o payload do painel manda string).
  eq(r({ parcela_num: '3', parcela_total: '9' }, 'Tênis'), ' · 3/9', 'número em texto');
}
console.log('  ok');


console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  falhas.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
