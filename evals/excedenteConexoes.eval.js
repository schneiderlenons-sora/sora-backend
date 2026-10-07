// =============================================================================
// EVAL — conexão de banco além do direito do plano.
//
// Esta regra pode DESLIGAR o banco de um cliente, e reconectar cria um
// consentimento novo (que a Polp cobra). Então o que o eval protege não é o
// caminho feliz: é cada forma de desligar alguém que não devia.
//
// Rodar: node evals/excedenteConexoes.eval.js
// =============================================================================
const { estadoExcedente, PRAZO_HORAS } = require('../src/services/excedenteConexoes');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const AGORA = new Date('2026-10-02T12:00:00Z');
const hAtras = (h) => new Date(AGORA.getTime() - h * 3600 * 1000).toISOString();

const cx = (id, { status = 'updated', created_at = '2026-01-01T00:00:00Z' } = {}) =>
  ({ external_id: id, status, created_at, instituicao: 'Banco ' + id });

console.log('-- 1. dentro do direito: nada acontece --');
{
  const r = estadoExcedente({ limite: 3, conexoes: [cx('a'), cx('b')], agora: AGORA });
  eq(r.estado, 'ok', '§1 estado ok');
  eq(r.excede, false, '§1 não excede');
  eq(r.aDesligar.length, 0, '§1 ninguém a desligar');
}
{
  // Exatamente no limite ainda é "ok" — o corte é >, nunca >=.
  const r = estadoExcedente({ limite: 1, conexoes: [cx('a')], agora: AGORA });
  eq(r.estado, 'ok', '§1 em cima do limite ainda está coberto');
}
console.log('  ok');

console.log('-- 2. SEM DADO NAO SE AFIRMA NADA (nem desliga) --');
{
  // Falha ao ler o plano. Tratar "não sei" como limite 0 desligaria a base toda.
  const casos = [
    ['limite undefined',   { conexoes: [cx('a')], agora: AGORA }],
    ['limite null',        { limite: null, conexoes: [cx('a')], agora: AGORA }],
    ['limite NaN',         { limite: NaN, conexoes: [cx('a')], agora: AGORA }],
    ['limite negativo',    { limite: -1, conexoes: [cx('a')], agora: AGORA }],
    ['conexoes undefined', { limite: 0, agora: AGORA }],
    ['conexoes null',      { limite: 0, conexoes: null, agora: AGORA }],
    ['nada',               {}],
  ];
  for (const [rotulo, arg] of casos) {
    const r = estadoExcedente(arg);
    eq(r.estado, 'indefinido', `§2 ${rotulo} -> indefinido`);
    eq(r.excede, false, `§2 ${rotulo} NAO afirma excesso`);
    eq(r.aDesligar.length, 0, `§2 ${rotulo} não desliga nada`);
  }
}
console.log('  ok');

console.log('-- 3. excede pela 1a vez: AVISA, nunca desliga --');
{
  // O caso do Thiago: vitalício, franquia 0, 1 conexão viva.
  const r = estadoExcedente({ limite: 0, conexoes: [cx('a')], agora: AGORA });
  eq(r.estado, 'avisando', '§3 estado avisando');
  eq(r.excedente, 1, '§3 uma conexão além do direito');
  eq(r.aDesligar.length, 0, '§3 PRIMEIRO AVISO NAO DESLIGA NADA');
  eq(r.horasRestantes, PRAZO_HORAS, '§3 e o prazo começa cheio');
}
console.log('  ok');

console.log('-- 4. O PRAZO SO CORRE DEPOIS DO 1o AVISO --');
{
  // Mesmo com o excedente antigo, sem `excedenteDesde` gravado o relógio começa
  // agora: quem já estava nesta situação antes de o aviso existir recebe os 2
  // dias inteiros, não um corte retroativo no primeiro dia de deploy.
  const r = estadoExcedente({ limite: 0, conexoes: [cx('a', { created_at: '2025-01-01T00:00:00Z' })], agora: AGORA });
  eq(r.estado, 'avisando', '§4 conexão de um ano atrás ainda só AVISA');
  eq(r.aDesligar.length, 0, '§4 nada é desligado sem aviso prévio gravado');
}
{
  const r = estadoExcedente({ limite: 0, conexoes: [cx('a')], excedenteDesde: hAtras(71), agora: AGORA });
  eq(r.estado, 'avisando', '§4 a 71h ainda está no prazo');
  eq(r.aDesligar.length, 0, '§4 e nada é desligado');
  eq(r.horasRestantes, 1, '§4 falta 1h');
}
{
  const r = estadoExcedente({ limite: 0, conexoes: [cx('a')], excedenteDesde: hAtras(72), agora: AGORA });
  eq(r.estado, 'vencido', '§4 em 72h (3 dias) vence');
  eq(r.aDesligar.length, 1, '§4 e aí sim desliga');
  eq(r.horasRestantes, 0, '§4 sem horas restantes');
}
{
  // Data corrompida/inválida no banco não pode valer como prazo vencido.
  const r = estadoExcedente({ limite: 0, conexoes: [cx('a')], excedenteDesde: 'ontem', agora: AGORA });
  eq(r.estado, 'avisando', '§4 data inválida reinicia o prazo, não o vence');
  eq(r.aDesligar.length, 0, '§4 e não desliga');
}
console.log('  ok');

console.log('-- 5. DESLIGA SO O EXCEDENTE, NUNCA A CONTA INTEIRA --');
{
  // Básico (franquia 1) com 3 conexões: sai 2, FICA 1.
  const r = estadoExcedente({
    limite: 1,
    conexoes: [
      cx('velha', { created_at: '2026-01-01T00:00:00Z' }),
      cx('media', { created_at: '2026-05-01T00:00:00Z' }),
      cx('nova',  { created_at: '2026-09-01T00:00:00Z' }),
    ],
    excedenteDesde: hAtras(72), agora: AGORA,
  });
  eq(r.excedente, 2, '§5 duas além do direito');
  eq(r.aDesligar.length, 2, '§5 desliga EXATAMENTE o excedente');
  eq(r.aDesligar.map((c) => c.external_id).join(','), 'nova,media', '§5 as mais novas primeiro');
  eq(r.aDesligar.some((c) => c.external_id === 'velha'), false, '§5 a mais antiga FICA');
}
console.log('  ok');

console.log('-- 6. CONEXAO MORTA SAI ANTES DA VIVA --');
{
  // Morta é custo puro: já não serve ao cliente. Desligá-la pode resolver o
  // excedente sem ninguém perder acesso a banco nenhum.
  const r = estadoExcedente({
    limite: 1,
    conexoes: [
      cx('viva-nova',   { status: 'updated', created_at: '2026-09-01T00:00:00Z' }),
      cx('morta-velha', { status: 'awaiting_authorization', created_at: '2026-01-01T00:00:00Z' }),
    ],
    excedenteDesde: hAtras(72), agora: AGORA,
  });
  eq(r.aDesligar.length, 1, '§6 só uma sai');
  eq(r.aDesligar[0].external_id, 'morta-velha', '§6 e é a MORTA, mesmo sendo a mais antiga');
}
{
  // `updating`/`authorised` também são vivas — não podem sair na frente de uma morta.
  for (const s of ['updating', 'authorised', 'authorized', 'UPDATED']) {
    const r = estadoExcedente({
      limite: 1,
      conexoes: [
        cx('viva',  { status: s, created_at: '2026-01-01T00:00:00Z' }),
        cx('morta', { status: 'error', created_at: '2026-09-01T00:00:00Z' }),
      ],
      excedenteDesde: hAtras(72), agora: AGORA,
    });
    eq(r.aDesligar[0] && r.aDesligar[0].external_id, 'morta', `§6 '${s}' conta como viva`);
  }
}
console.log('  ok');

console.log('-- 7. quem contratou avulso fica coberto --');
{
  // Vitalício que paga 2 conexões: limite = 2 (franquia 0 + 2 pagas). O limite
  // chega pronto de `acessoOpenFinance`; aqui só se confirma que 2 não excede.
  const r = estadoExcedente({ limite: 2, conexoes: [cx('a'), cx('b')], excedenteDesde: hAtras(999), agora: AGORA });
  eq(r.estado, 'ok', '§7 regularizou -> volta pra ok mesmo com marco antigo');
  eq(r.aDesligar.length, 0, '§7 e nada é desligado');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('OK excedenteConexoes: avisa, da prazo, e so desliga o excedente — nunca por falta de dado');
process.exit(0);
