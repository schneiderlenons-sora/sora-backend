// =============================================================================
// EVAL da trava que impede a IA de reescrever a DATA do compromisso.
//
// ⚠️ O QUE ESTE EVAL PROTEGE: o compromisso nascer no DIA ERRADO sem ninguém
// perceber. A Sora responde "Marquei!" com cara de sucesso, o usuário confia,
// e o lembrete dispara no dia errado (ou não dispara). Foi o relato real de
// set/2026: "25/09 às 10:00" virou 24/09.
//
// A causa não foi o parser local — ele acerta. Foi o FALLBACK DE IA (só roda
// quando o parser local não reconhece a frase) traduzindo "25/09" para
// "quinta" e errando a conta (25/09/2026 é SEXTA).
//
// ⚠️ Este eval NÃO chama a OpenAI de propósito: o comando que a IA devolveu
// entra como DADO FIXO (o real, copiado da reprodução). Assim ele é
// determinístico, roda de graça e não fica instável quando o modelo muda.
//
// Rodar:  npm run eval:agenda-data-ia
// =============================================================================
const { preservarDataOriginal, parseDataPt } = require('../src/handlers/grow');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

// As datas são relativas a HOJE, então o eval compara contra o que o próprio
// parser devolve — nunca contra uma string cravada. Assim ele não quebra
// sozinho quando o ano vira.
const isoDe = (txt) => parseDataPt(txt)?.iso ?? null;
const isoDoCmd = (cmd) => parseDataPt(String(cmd).toLowerCase().replace(/^marca[r]?\s+/i, ''))?.iso ?? null;

// ── 1. O BUG REAL — a IA trocou a data numérica por dia da semana ──────────
console.log('── 1. o caso do cliente (25/09 → "quinta") ──');
{
  const msg = 'Dr.Aluísio Cardiologista, 25/09 às 10:00';
  const cmdIA = 'marca Dr.Aluísio Cardiologista quinta 10h';   // ← o que a IA devolveu de verdade

  // Sem a trava, o comando aponta pra OUTRO dia — é o bug.
  const antes = isoDoCmd(cmdIA);
  eq(antes !== isoDe('25/09'), true, 'o comando cru da IA aponta pro dia errado (é o bug)');

  const corrigido = preservarDataOriginal(msg, cmdIA);
  eq(isoDoCmd(corrigido), isoDe('25/09'), 'depois da trava, a data volta a ser a que a pessoa escreveu');
  eq(/quinta/i.test(corrigido), false, 'e o "quinta" inventado sai do comando');
}
console.log('  ok');

// ── 2. Quando a IA ACERTA, a trava não encosta ─────────────────────────────
//
// ⚠️ Importante: a trava não pode "corrigir" o que já estava certo, senão ela
// vira a nova fonte de bug. Os dois formatos abaixo são os que a IA devolve
// quando acerta (medidos no modelo real).
console.log('── 2. IA acertou → não mexe ──');
{
  const msg = 'Dr.Aluísio Cardiologista, 25/09 às 10:00';
  for (const cmd of [
    'marca Dr.Aluísio Cardiologista 25/09 10h',
    'marca Dr.Aluísio Cardiologista dia 25 10h',
  ]) {
    eq(preservarDataOriginal(msg, cmd), cmd, `intacto: "${cmd}"`);
  }
}
console.log('  ok');

// ── 3. A IA PERDEU a data — sem isso o compromisso cai em HOJE ─────────────
//
// `dataISO = dt ? dt.iso : isoD(new Date())` no handler: comando sem data
// nenhuma vira "hoje" silenciosamente, que é o mesmo estrago com outra cara.
console.log('── 3. IA perdeu a data → devolve ──');
{
  const msg = 'Dr.Aluísio Cardiologista, 25/09 às 10:00';
  const corrigido = preservarDataOriginal(msg, 'marca Dr.Aluísio Cardiologista 10h');
  eq(isoDoCmd(corrigido), isoDe('25/09'), 'a data escrita pela pessoa é reposta no comando');
}
console.log('  ok');

// ── 4. "dia 25" também é data explícita ────────────────────────────────────
console.log('── 4. "dia 25" (o outro formato explícito) ──');
{
  const msg = 'consulta dia 25 às 10:00';
  const corrigido = preservarDataOriginal(msg, 'marca consulta quinta 10h');
  eq(isoDoCmd(corrigido), isoDe('dia 25'), 'trocar "dia 25" por dia da semana também é revertido');
}
console.log('  ok');

// ── 5. ⚠️ DATA RELATIVA FICA DE FORA — a trava não pode ser ampla demais ───
//
// Em "amanhã"/"terça" quem faz a conta é o parser local, e a IA só repassa a
// palavra. Se a trava mexesse aqui, ela brigaria com o caminho que FUNCIONA.
console.log('── 5. data relativa: a trava não se mete ──');
{
  eq(preservarDataOriginal('tenho médico amanhã às 10', 'marca médico terça 10h'),
    'marca médico terça 10h', 'original relativa ("amanhã") → não intervém');
  eq(preservarDataOriginal('tenho médico terça às 10', 'marca médico quarta 10h'),
    'marca médico quarta 10h', 'original relativa ("terça") → não intervém');
}
console.log('  ok');

// ── 6. Sem data na frase / comando vazio ───────────────────────────────────
console.log('── 6. bordas ──');
{
  eq(preservarDataOriginal('fiz academia', 'fiz academia'), 'fiz academia', 'sem data → intacto');
  eq(preservarDataOriginal('Dr.Aluísio 25/09', null), null, 'comando null → null');
  eq(preservarDataOriginal('Dr.Aluísio 25/09', ''), '', 'comando vazio → vazio');
  eq(preservarDataOriginal('', 'marca x quinta 10h'), 'marca x quinta 10h', 'mensagem vazia → intacto');
}
console.log('  ok');

// ── 7. Não é só agenda: comando de outro tipo não é tocado ─────────────────
console.log('── 7. outros comandos do Grow ──');
{
  // "comprar leite dia 25" é lista de compras — a data nem entra no fluxo,
  // mas a trava também não pode corromper o comando.
  const cmd = 'comprar leite';
  const r = preservarDataOriginal('comprar leite dia 25', cmd);
  eq(isoDoCmd(r), isoDe('dia 25'), 'anexa a data sem quebrar o comando');
  eq(r.startsWith('comprar leite'), true, 'e o comando continua sendo o de compras');
}
console.log('  ok');

// ── Resultado ───────────────────────────────────────────────────────────────
if (falhas.length) {
  console.error(`\n❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n✅ data do compromisso: a IA não reescreve o que a pessoa escreveu');
