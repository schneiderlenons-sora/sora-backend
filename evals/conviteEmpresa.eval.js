// =============================================================================
// EVAL do convite por empresa (Fase 3 — regras puras).
//
// O ponto perigoso é controle de ACESSO: aceitar um convite expirado/usado, ou
// deixar o dono ser removido, abre a empresa pra quem não devia ou tranca quem
// devia. Os testes travam isso.
//
// Rodar:  npm run eval:convite-empresa
// =============================================================================
const C = require('../src/services/conviteEmpresa');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const AGORA = new Date('2026-10-10T12:00:00Z');
const futuro = C.expiraEm(AGORA);                            // +7 dias
const passado = new Date(AGORA.getTime() - 1000).toISOString();

console.log('── 1. papel do convite ──');
ok(C.papelConviteValido('admin') && C.papelConviteValido('operador') && C.papelConviteValido('leitura'), 'os 3 papéis valem');
ok(!C.papelConviteValido('dono') && !C.papelConviteValido('') && !C.papelConviteValido(null), 'papel fora da lista não vale');
console.log('  ok');

console.log('── 2. expiração é 7 dias ──');
ok(Math.round((Date.parse(C.expiraEm(AGORA)) - AGORA.getTime()) / 86400000) === C.CONVITE_TTL_DIAS, 'expira em CONVITE_TTL_DIAS');
console.log('  ok');

console.log('── 3. convite utilizável ──');
{
  ok(C.conviteUtilizavel({ id: 'c1', usado: false, expira_em: futuro }, AGORA).ok, 'válido e no prazo → ok');
  ok(!C.conviteUtilizavel(null, AGORA).ok, 'inexistente recusa');
  ok(!C.conviteUtilizavel({ id: null }, AGORA).ok, 'sem id recusa');
  ok(!C.conviteUtilizavel({ id: 'c1', usado: true, expira_em: futuro }, AGORA).ok, 'JÁ USADO recusa (não é link eterno)');
  ok(!C.conviteUtilizavel({ id: 'c1', usado: false, expira_em: passado }, AGORA).ok, 'EXPIRADO recusa');
  ok(!C.conviteUtilizavel({ id: 'c1', usado: false, expira_em: 'xx' }, AGORA).ok, 'sem data válida recusa (na dúvida, não aceita)');
  // ordem das mensagens
  ok(/usado/i.test(C.conviteUtilizavel({ id: 'c1', usado: true, expira_em: passado }, AGORA).erro), 'usado tem prioridade de mensagem sobre expirado');
}
console.log('  ok');

console.log('── 4. o dono nunca é removido/rebaixado ──');
{
  ok(C.podeMexerNoMembro('dono1', 'membro2').ok, 'mexer num membro comum pode');
  ok(!C.podeMexerNoMembro('dono1', 'dono1').ok, 'o DONO não pode ser removido/rebaixado');
  ok(!C.podeMexerNoMembro('dono1', null).ok, 'membro inválido recusa');
  // compara como string (ids podem vir number/uuid)
  ok(!C.podeMexerNoMembro(1, '1').ok, 'compara por string: 1 === "1" é o dono');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) { console.log('\n── Falhas ──'); falhas.forEach((f) => console.log(`  ${f}`)); process.exit(1); }
