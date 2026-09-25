// =============================================================================
// EVAL — por que o cartão não veio (`statusCartao` em routes/openFinance.js).
//
// Relato de cliente (Vander, 25/09/2026): o cartão do BTG não aparece. Ele
// removeu a conexão na Sora, removeu TODAS as conexões pelo app do BTG e
// reconectou do zero — três vezes. A conta vem; o cartão não.
//
// ⚠️ A TELA MANDAVA RECONECTAR, e era o conselho errado. Reconectar não traz o
// que o banco não libera, e cada volta cria um consentimento novo que a Polp
// COBRA. Quem responde agora é o próprio banco, via
// `GET /consents/{id}/resources` — e cada status leva a uma AÇÃO diferente,
// inclusive "não faça nada".
//
// ⚠️ O caso que o eval existe pra proteger é `nao_pedido`: `criarConsentimento`
// tem fallback em cascata e a última tentativa pede SÓ `ACCOUNT`. Se isso
// acontecer, o furo é NOSSO e reconectar é a solução certa. Confundir esse
// caso com "o banco não libera" manda o cliente desistir de algo que tem
// conserto; confundir o contrário o manda reconectar para sempre.
//
// Rodar:  npm run eval:cartao-status
// =============================================================================

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

// A função DE VERDADE, não uma cópia: a rota importa deste mesmo módulo.
const { statusCartao } = require('../src/services/statusCartaoOF');

const CONTA_OK = [{ type: 'ACCOUNT', status: 'AVAILABLE' }];
const TODOS = ['ACCOUNT', 'CREDIT_CARD_ACCOUNT', 'CREDIT_OPERATIONS', 'INVESTMENTS', 'EXCHANGE'];

(async () => {
  console.log('── 1. tem cartão → não diz nada ──');
  {
    eq(statusCartao({ cartoes: 2, produtos: TODOS, recursos: CONTA_OK }), 'ok',
      'com cartão vinculado o resto é irrelevante');
  }
  console.log('  ok');

  console.log('── 2. sem diagnóstico → NÃO AFIRMA NADA ──');
  {
    eq(statusCartao({ cartoes: 0 }), null,
      '⚠️ sem a 175 rodada, devolve null e a tela cai no texto genérico de hoje');
    eq(statusCartao({ cartoes: 0, produtos: TODOS, recursos: [] }), null,
      '⚠️ lista de recursos VAZIA não vira "inexistente" — vazio é "não li", não "não tem"');
  }
  console.log('  ok');

  console.log('── 3. o furo é NOSSO: o pedido saiu sem cartão ──');
  {
    eq(statusCartao({ cartoes: 0, produtos: ['ACCOUNT'], recursos: CONTA_OK }), 'nao_pedido',
      '⚠️ é o fallback "só conta" do criarConsentimento — aqui reconectar RESOLVE');
    // E não pode ser confundido com culpa do banco mesmo que o banco tenha o cartão.
    eq(statusCartao({
      cartoes: 0, produtos: ['ACCOUNT'],
      recursos: [...CONTA_OK, { type: 'CREDIT_CARD_ACCOUNT', status: 'AVAILABLE' }],
    }), 'nao_pedido',
      '⚠️ o que a Sora PEDIU vence o que o banco tem — senão culparíamos o banco por erro nosso');
  }
  console.log('  ok');

  console.log('── 4. o banco respondeu: cada status, uma ação ──');
  {
    const com = (s) => statusCartao({
      cartoes: 0, produtos: TODOS,
      recursos: [...CONTA_OK, { type: 'CREDIT_CARD_ACCOUNT', status: s }],
    });
    eq(com('AVAILABLE'), 'a_caminho', 'liberado mas ainda não chegou → esperar');
    // ⚠️ A doc é explícita: TEMPORARILY_UNAVAILABLE pede retry, UNAVAILABLE é
    // encerramento. Tratar como iguais manda reconectar por algo que passa só.
    eq(com('TEMPORARILY_UNAVAILABLE'), 'temporario', 'fora do ar → volta sozinho');
    eq(com('UNAVAILABLE'), 'indisponivel', 'encerrado → reconectar não adianta');
    eq(com('PENDING_AUTHORISATION'), 'falta_titular', 'conta conjunta → falta outro titular');
    eq(com('QUALQUER_COISA_NOVA'), 'indisponivel',
      'status desconhecido cai no conservador, nunca em "está vindo"');
  }
  console.log('  ok');

  console.log('── 5. o banco não listou cartão nenhum ──');
  {
    eq(statusCartao({ cartoes: 0, produtos: TODOS, recursos: CONTA_OK }), 'inexistente',
      '⚠️ pedimos cartão, o banco listou recursos e nenhum é cartão — a resposta é dele');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ status do cartão: todos os casos passaram');
})();
