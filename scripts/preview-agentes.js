// =============================================================================
// Mostra, no terminal, COMO cada aviso vai chegar no WhatsApp com a voz do
// agente ligada. Serve pra revisar o tom ANTES de ligar `AGENTES_VOZ=1` em
// produção — mudar a voz muda o que TODO usuário recebe.
//
// Rodar:  npm run agentes:preview
// =============================================================================
process.env.AGENTES_VOZ = '1';
const { falar, AGENTES, VOZES } = require('../src/agentes');

// Exemplos com a MESMA cara dos textos reais dos crons (jobs/index.js).
const EXEMPLOS = {
  'sardinha.recorrencias':
    '🔁 *Recorrências de hoje*\n\n🔴 Aluguel — R$ 1.800,00\n🔴 Internet — R$ 119,90',
  'sardinha.lembretes':
    '🔔 *LEMBRETE:*\n💸 Pagar *IPVA*\nValor: R$ 642,30\nVencimento: 15/08/2026',
  'sardinha.parcelas':
    '💳 *Parcela 3/12 — Notebook*\n💵 R$ 291,58 no cartão *Nubank*\nPra pagar, responda: "pagar parcela da Notebook"',
  'sardinha.fatura':
    '💳 *Fatura do Nubank*\nFechou em R$ 1.544,01 e vence dia 02/09.',
  'jacques.resumo-semanal':
    '📊 *Sua semana*\n\n*Semana mais calma*\nVocê cortou o delivery pela metade e migrou pra padaria.\n\n💸 Gastos: R$ 412,90\n💰 Receitas: R$ 1.200,00\n🎯 Hábitos: 71% da semana\n🏃 Treino: 3 sessões',
  'jacques.resumo-mensal':
    '🧾 *Fechamento de Julho*\n\n*Mês de equilíbrio*\nReceitas superaram gastos pela primeira vez em três ciclos.\n\n💸 Gastos: R$ 2.100,00\n💰 Receitas: R$ 3.400,00\n📊 Saldo: R$ 1.300,00',
  'don-baleone.dividas':
    '🔔 *Lembrete de dívida*\n\n📌 *Empréstimo* (Nubank)\n💵 R$ 629,51\n📅 Vence em *3 dias* (dia 10)',
  'don-baleone.limite':
    '🚨 *Limite de gastos*\n\nVocê já usou *128%* do teto de Alimentação: R$ 1.284,00 de R$ 1.000,00.',
  'aurora.briefing':
    '☀️ *Seu dia*\n\n📌 Dentista às 15h\n💰 Luz vence hoje — R$ 187,40\n🩺 Consulta amanhã',
  'aurora.habitos':
    '🎯 *Lembrete de hábitos*\n\nVocê ainda tem *2* hábitos pra marcar hoje. Bora fechar o dia? 💪',
  'aurora.compromissos':
    '📅 *Dentista*\nHoje às 15h · 📍 Rua das Flores, 120',
  'aurora.manutencoes':
    '🔧 *Manutenção: 💧 Trocar filtro de água*\nVenceu há 3 dias. Quando fizer, responda *fiz a manutenção*.',
  'dr-house.medicamentos':
    '💊 *Hora de tomar Losartana* 50mg\nQuando tomar, responda *tomei Losartana* pra eu marcar.',
  'dr-house.consultas':
    '🩺 *Consulta amanhã*\nCardiologista às 09:00 · 📍 Clínica Central',
};

const LARG = 72;
const linha = (c = '─') => c.repeat(LARG);

console.log(`\n${linha('═')}`);
console.log('  COMO OS AVISOS VÃO CHEGAR COM A VOZ DOS AGENTES');
console.log(`  ${Object.keys(VOZES).length} avisos · ${new Set(Object.keys(VOZES).map((k) => k.split('.')[0])).size} agentes`);
console.log(linha('═'));

let agenteAtual = '';
for (const chave of Object.keys(VOZES)) {
  const [agId, avisoId] = chave.split('.');
  const agente = AGENTES[agId];

  if (agId !== agenteAtual) {
    agenteAtual = agId;
    console.log(`\n\n${linha()}`);
    console.log(`  ${agente.emoji}  ${agente.nome.toUpperCase()}`);
    console.log(linha());
  }

  const original = EXEMPLOS[chave] || '(sem exemplo cadastrado)';
  const r = falar(agId, avisoId, { texto: original, core: original.replace(/\n/g, ' '), seed: 'preview' });

  console.log(`\n  ▸ ${avisoId}`);
  console.log('  ┌' + '─'.repeat(LARG - 4) + '┐');
  for (const l of r.texto.split('\n')) console.log('  │ ' + l);
  console.log('  └' + '─'.repeat(LARG - 4) + '┘');
  console.log(`    template (1 linha, ${r.core.length} chars):`);
  console.log(`    ${r.core.slice(0, 150)}${r.core.length > 150 ? '…' : ''}`);
}

console.log(`\n\n${linha('═')}`);
console.log('  Para LIGAR em produção: AGENTES_VOZ=1 no Render.');
console.log('  Para desligar: remover a variável (ou = 0). Volta na hora.');
console.log(`${linha('═')}\n`);
