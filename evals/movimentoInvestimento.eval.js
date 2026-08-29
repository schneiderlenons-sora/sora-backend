// =============================================================================
// EVAL de `ehMovimentoInvestimento` (services/categorizar).
//
// Aplicar e resgatar não é gastar nem ganhar — o dinheiro só muda de bolso.
// Rendimento e dividendo, sim: o patrimônio aumenta.
//
// O erro caro aqui é ASSIMÉTRICO:
//   · deixar uma aplicação passar → o relatório fica inflado (chato, visível)
//   · marcar um RENDIMENTO como transferência → some a renda do usuário, e ele
//     nunca vai saber que ganhou aquilo (grave, invisível)
// Por isso a seção 2 é a mais densa: são as frases que CONTÊM "aplicação" mas
// são renda.
//
// Rodar:  npm run eval:mov-invest
// =============================================================================
const { ehMovimentoInvestimento } = require('../src/services/categorizar');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── 1. É movimentação (vira transferência) ─────────────────────────────────
console.log('── 1. aplicação e resgate ──');
{
  // Frases REAIS da base, com a grafia que cada banco usa.
  const sim = [
    'Aplicacao: "CDB Porq Obj BANCO INTER SA"',
    'Aplicação RDB',
    'Aplicação - Cdb Porq Obj Banco Inter S A',
    'Aplicação COFRINHOS',
    'Resgate: "CDB Porq Obj BANCO INTER SA"',
    'Resgate RDB',
    'Resgate COFRINHOS',
    'Resgate RESGATE CDB Cofrinhos',
    'RESGATE CDBC254NM87 | CDB BMG - DEZ/2026',
    'Resgate - Global Account',
    'APLICACAO AUTOMATICA',            // sem "remuneração" na frente é aplicação
    'Liquidação de aplicação',
  ];
  for (const s of sim) ok(ehMovimentoInvestimento(s, ''), `deveria ser movimentação: "${s}"`);
}
console.log('  ok');

// ── 2. NÃO é movimentação — é RENDA (o erro grave) ─────────────────────────
console.log('── 2. rendimento/dividendo NÃO podem virar transferência ──');
{
  const nao = [
    // ⚠️ Estas TÊM a palavra "aplicação"/"invest" e mesmo assim são RENDA.
    'REMUNERACAO APLICACAO AUTOMATICA',
    'REMUNERAÇÃO APLICAÇÃO AUTOMÁTICA',
    'RENTAB.INVEST FACILCRED* - DOCTO: 2',
    'Rent.inv.facil',
    'RENTAB.INVEST FACIL',
    'Rendimento de aplicação',
    'Juros sobre aplicação',
    'Crédito Evento B3 - * Prov * Dividendos',
    'JCP ITSA4',
    'Provento BBAS3',
    'Estorno - Aplicação',        // devolução, tratada à parte
  ];
  for (const s of nao) ok(!ehMovimentoInvestimento(s, ''), `NÃO podia ser movimentação: "${s}"`);
}
console.log('  ok');

// ── 2b. IMPOSTO sobre resgate é DESPESA de verdade ─────────────────────────
// ⚠️ Estas três apareceram na SIMULAÇÃO do backfill, não no meu planejamento:
// contêm "resgate" e eu as teria convertido em transferência. Imposto diminui
// o patrimônio e o dinheiro não volta — é despesa, igual rendimento é receita.
console.log('── 2b. imposto sobre resgate ──');
{
  const nao = [
    'IRRF S/RESGATE FUNDOS - Trend DI FIC RF Simples RL',
    'IR - RESGATE CDBC254NM87 | CDB BMG - DEZ/2026',
    'IOF - RESGATE CDBC254NM87 | CDB BMG - DEZ/2026',
    'Come-cotas fundo XP',
    'Imposto sobre aplicação',
    'Taxa de custódia sobre aplicação',
    // Correção de saldo tem fluxo próprio — não é movimentação de investimento.
    'Ajuste de saldo (Sicoob Aplicação)',
  ];
  for (const s of nao) ok(!ehMovimentoInvestimento(s, ''), `imposto/ajuste NÃO é transferência: "${s}"`);
}
console.log('  ok');

// ── 3. Falsos positivos de palavra ─────────────────────────────────────────
console.log('── 3. não é investimento coisa nenhuma ──');
{
  const nao = [
    // ⚠️ CASO REAL: "passAPORTE" contém "aporte". Sem o \b, um passeio de bike
    // virava movimentação de investimento.
    'Passaporte ROTA BIKER',
    'Taxa de passaporte',
    'Suporte técnico mensal',
    'Reaporte de material',
    'PIX ENVIADO - CONSTRUCTION INVEST - USA',   // "invest" sozinho não basta
    'Mercado Livre',
    'UBER *EATS',
    'Pagamento do cartão LaTam Pass',            // é fatura, tem regra própria
    '',
    null,
    undefined,
  ];
  for (const s of nao) ok(!ehMovimentoInvestimento(s, ''), `NÃO podia casar: "${s}"`);
}
console.log('  ok');

// ── 4. A categoria externa também é lida ───────────────────────────────────
console.log('── 4. categoria do banco ──');
{
  ok(ehMovimentoInvestimento('', 'Resgate'), 'categoria externa "Resgate" conta');
  ok(!ehMovimentoInvestimento('', 'Dividendos'), 'categoria "Dividendos" NÃO conta');
  // Renda vence mesmo quando a outra ponta casaria.
  ok(!ehMovimentoInvestimento('Aplicação', 'Rendimento'),
     'renda na categoria externa vence a aplicação na descrição');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.log(`❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.log('   · ' + f);
  process.exit(1);
}
console.log('✅ ehMovimentoInvestimento: tudo passou');
