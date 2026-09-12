// =============================================================================
// EVAL DO EVAL — o `faturaVista.eval.js` continua verde em QUALQUER data?
//
// POR QUE ISTO EXISTE. Em 12/09/2026 o `eval:fatura-vista` foi encontrado
// VERMELHO em produção, com 4 falhas — e nenhuma linha de código de produção
// havia mudado. O cartão do cenário fecha dia 3 e vence dia 10; as asserções
// pediam a competência '2026-09' CRAVADA. Quando o vencimento de 10/09 passou,
// `competenciaAtual` virou '2026-10', o ramo do simulado deixou de casar e o
// bloco inteiro caiu.
//
// ⚠️ VERMELHO POR CALENDÁRIO É PIOR QUE VERMELHO POR BUG. Um eval que falha sem
// culpa do código ensina a equipe a ignorá-lo — e aí ele deixa de proteger.
// Nesse dia ele não pegou NENHUM dos dois bugs reais de fatura que existiam
// (parcela em dobro por arredondamento, e o limite usado aparecendo no modal),
// porque ninguém olhava mais para ele.
//
// Os irmãos (`cicloFatura`, `parcelasPrevistas`, `pagamentoFatura`) já
// congelavam o "hoje". O `faturaVista` era o único que não.
//
// ⚠️ O QUE ESTE ARQUIVO PROTEGE não é uma regra de negócio — é a CONFIABILIDADE
// do eval que protege as regras de negócio. Ele roda o `faturaVista.eval.js`
// inteiro sob datas simuladas: se alguém cravar um mês de novo, uma destas
// datas fica vermelha aqui, hoje, em vez de aparecer sozinha num dia 15
// qualquer daqui a meses.
//
// Rodar:  npm run eval:fatura-vista-datas
// =============================================================================
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Viradas que já quebraram ou podem quebrar: início/fim de mês, dia do
// fechamento, dia do vencimento, virada de ANO e 29/02 de ano bissexto.
const DATAS = [
  '2026-09-01', '2026-09-03', '2026-09-08', '2026-09-12', '2026-09-13',
  '2026-09-15', '2026-09-30', '2026-10-01', '2026-10-08', '2026-10-13',
  '2026-11-30', '2026-12-31', '2027-01-01', '2027-02-28', '2027-03-01',
  '2028-02-29',
];

const ALVO = path.join(__dirname, 'faturaVista.eval.js');

// Congela `new Date()` e `Date.now()` e só então carrega o eval alvo.
// ⚠️ A data vem por VARIÁVEL DE AMBIENTE, não por argv. Com \`node -e\` os
// argumentos deslocam (argv[1] passa a ser o primeiro extra), e ler argv[2]
// devolvia `undefined` — o congelamento virava "Invalid Date" e TODAS as datas
// apareciam vermelhas, inclusive as que estão certas. Foi o primeiro resultado
// deste arquivo, e um falso vermelho aqui teria mandado alguém caçar um bug
// inexistente no eval alvo.
const VIAJANTE = `
  const alvo = process.env.SORA_DATA_SIMULADA;
  const Real = Date;
  const fixo = new Real(alvo + 'T15:00:00-03:00').getTime();
  class Fake extends Real {
    constructor(...a) { super(...(a.length ? a : [fixo])); }
    static now() { return fixo; }
  }
  global.Date = Fake;
  require(${JSON.stringify(ALVO)});
`;

const falhas = [];
console.log(`── faturaVista.eval.js sob ${DATAS.length} datas simuladas ──`);
for (const d of DATAS) {
  try {
    execFileSync(process.execPath, ['-e', VIAJANTE], {
      stdio: 'pipe',
      env: { ...process.env, SORA_DATA_SIMULADA: d },
    });
    console.log(`  ${d}  verde`);
  } catch (e) {
    const saida = `${e.stdout || ''}${e.stderr || ''}`;
    const quais = saida.split('\n').filter((l) => l.trim().startsWith('·')).slice(0, 4);
    falhas.push(`${d}\n${quais.map((q) => '      ' + q.trim()).join('\n')}`);
    console.log(`  ${d}  VERMELHO`);
  }
}

console.log('');
if (falhas.length) {
  console.error(`✗ o eval da fatura apodreceu em ${falhas.length} data(s):`);
  for (const f of falhas) console.error('  · ' + f);
  console.error('');
  console.error('  Quase sempre é uma competência CRAVADA ("2026-09") onde ela');
  console.error('  deveria ser DERIVADA (competenciaAtual(cartao)). O ramo do');
  console.error('  simulado só vale na competência que o código considera atual.');
  process.exit(1);
}
console.log('✓ valor exibido da fatura: verde em todas as datas testadas');
