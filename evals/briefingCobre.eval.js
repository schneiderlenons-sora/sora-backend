// =============================================================================
// EVAL — o briefing matinal cobriu mesmo este compromisso?
//
// Relato (Maurício, 30/09/2026): "não estou recebendo os avisos sobre tarefas
// ou lembretes agendados".
//
// Reconstruído na conta dele, com os dados reais:
//   briefing ligado, horário 08:00, `agenda_briefing_ultimo` = 2026-09-30
//   3 compromissos criados 2026-09-30T11:23Z (= 08:23 em SP), para 10:00/11:00
//   lembrete_ativo = true, antecedência 60 min
//   → todos saíram com `lembrete_enviado = true` SEM nada ter sido enviado
//
// Rodar:  node evals/briefingCobre.eval.js
// =============================================================================
const { briefingCobriu, instanteSP } = require('../src/services/briefingCobre');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const HOJE = '2026-09-30';

console.log('── 1. O CASO DO RELATO ──');
{
  // Criado 08:23 em SP, briefing das 08:00 já tinha saído → NÃO cobriu.
  eq(briefingCobriu({
    briefingUltimo: HOJE, briefingHorario: '08:00',
    criadoEm: '2026-09-30T11:23:19.032Z', hojeStr: HOJE,
  }), false, '⚠️ §1 criado 23 min DEPOIS do briefing → o lembrete TEM de sair');

  // O mesmo compromisso, criado na véspera: aí sim o briefing o listou.
  eq(briefingCobriu({
    briefingUltimo: HOJE, briefingHorario: '08:00',
    criadoEm: '2026-09-29T20:00:00.000Z', hojeStr: HOJE,
  }), true, '§1 criado ontem → o briefing cobriu, pode suprimir');
}
console.log('  ok');

console.log('── 2. a borda exata do horário do briefing ──');
{
  const base = { briefingUltimo: HOJE, briefingHorario: '08:00', hojeStr: HOJE };
  // 07:59 em SP = 10:59 UTC
  eq(briefingCobriu({ ...base, criadoEm: '2026-09-30T10:59:00Z' }), true, '§2 um minuto antes: coberto');
  // 08:00 em SP = 11:00 UTC — o briefing roda a partir desse minuto
  eq(briefingCobriu({ ...base, criadoEm: '2026-09-30T11:00:00Z' }), true, '§2 no minuto exato: coberto');
  // 08:01 em SP = 11:01 UTC
  eq(briefingCobriu({ ...base, criadoEm: '2026-09-30T11:01:00Z' }), false, '§2 um minuto depois: NÃO coberto');
}
console.log('  ok');

console.log('── 3. ⚠️ SEM BRIEFING HOJE, NADA É SUPRIMIDO ──');
{
  const base = { briefingHorario: '08:00', criadoEm: '2026-09-29T12:00:00Z', hojeStr: HOJE };
  eq(briefingCobriu({ ...base, briefingUltimo: null }), false, '§3 nunca enviou briefing');
  eq(briefingCobriu({ ...base, briefingUltimo: '2026-09-29' }), false, '⚠️ §3 briefing de ONTEM não cobre hoje');
  eq(briefingCobriu({ ...base, briefingUltimo: '' }), false, '§3 vazio');
  // O briefing de hoje ainda vai sair (horário mais tarde): como ele ainda não
  // saiu, não há cobertura — e perder o aviso é pior que repeti-lo.
  eq(briefingCobriu({ ...base, briefingUltimo: undefined }), false, '§3 ainda não rodou hoje');
}
console.log('  ok');

console.log('── 4. ⚠️ NA DÚVIDA, O AVISO SAI ──');
{
  const base = { briefingUltimo: HOJE, briefingHorario: '08:00', hojeStr: HOJE };
  eq(briefingCobriu({ ...base, criadoEm: null }), false, '⚠️ §4 sem created_at não se afirma cobertura');
  eq(briefingCobriu({ ...base, criadoEm: 'não é data' }), false, '§4 data inválida');
  eq(briefingCobriu({ ...base, criadoEm: undefined }), false, '§4 undefined');
}
console.log('  ok');

console.log('── 5. horário do briefing fora do padrão ──');
{
  const base = { briefingUltimo: HOJE, hojeStr: HOJE };
  // Briefing às 06:30 (09:30 UTC): criado 07:00 SP (10:00 UTC) → não coberto.
  eq(briefingCobriu({ ...base, briefingHorario: '06:30', criadoEm: '2026-09-30T10:00:00Z' }),
    false, '§5 briefing cedo, compromisso criado depois');
  // Briefing às 21:00 (00:00 UTC do dia seguinte): criado 09:00 SP → coberto.
  eq(briefingCobriu({ ...base, briefingHorario: '21:00', criadoEm: '2026-09-30T12:00:00Z' }),
    true, '§5 briefing tarde cobre o que foi criado de manhã');
  // Horário corrompido cai no padrão 08:00.
  eq(briefingCobriu({ ...base, briefingHorario: 'xx', criadoEm: '2026-09-30T10:00:00Z' }),
    true, '§5 horário inválido → assume 08:00 (07:00 SP está coberto)');
  eq(briefingCobriu({ ...base, briefingHorario: null, criadoEm: '2026-09-30T11:30:00Z' }),
    false, '§5 …e 08:30 SP continua fora');
}
console.log('  ok');

console.log('── 6. ⚠️ O INSTANTE É O DE SÃO PAULO, NÃO O DO SERVIDOR ──');
{
  // O Render roda em UTC. Sem converter, 11:23Z seria lido como 11:23 e
  // pareceria depois de qualquer briefing matinal — por acaso daria o
  // resultado certo aqui, e errado no sentido oposto à noite.
  eq(instanteSP('2026-09-30T11:23:19.032Z'), '2026-09-30 08:23', '§6 11:23 UTC = 08:23 em SP');
  eq(instanteSP('2026-10-01T02:30:00Z'), '2026-09-30 23:30', '⚠️ §6 02:30 UTC ainda é dia 30 em SP');
  eq(instanteSP('2026-09-30T03:00:00Z'), '2026-09-30 00:00', '§6 meia-noite não vira 24:00');
  eq(instanteSP('data ruim'), null, '§6 inválido → null');

  // Um compromisso criado às 23h30 de ONTEM em SP é coberto pelo briefing de
  // hoje. Lido em UTC ele seria "01/10 02:30" e passaria por criado DEPOIS.
  eq(briefingCobriu({
    briefingUltimo: '2026-10-01', briefingHorario: '08:00',
    criadoEm: '2026-10-01T02:30:00Z', hojeStr: '2026-10-01',
  }), true, '⚠️ §6 criado 23h30 de ontem em SP → coberto pelo briefing de hoje');
}
console.log('  ok');

console.log('── 7. ⚠️ A RESPOSTA NÃO PODE DEPENDER DO FUSO DO PROCESSO ──');
{
  // O Render roda em UTC e a máquina de quem desenvolve costuma estar em SP —
  // então um bug de fuso aqui passa despercebido em quem escreve o código e
  // morde só em produção. Rodar em subprocesso é o único jeito de provar:
  // `TZ` é lido uma vez, no boot do processo.
  const { execFileSync } = require('child_process');
  const codigo = `
    const { briefingCobriu, instanteSP } = require('./src/services/briefingCobre');
    const r = [
      instanteSP('2026-09-30T11:23:19.032Z'),
      instanteSP('2026-10-01T02:30:00Z'),
      instanteSP('2026-09-30T03:00:00Z'),
      briefingCobriu({ briefingUltimo: '2026-09-30', briefingHorario: '08:00',
                       criadoEm: '2026-09-30T11:23:19.032Z', hojeStr: '2026-09-30' }),
      briefingCobriu({ briefingUltimo: '2026-09-30', briefingHorario: '08:00',
                       criadoEm: '2026-09-29T20:00:00.000Z', hojeStr: '2026-09-30' }),
    ].join('|');
    process.stdout.write(r);
  `;
  const esperado = '2026-09-30 08:23|2026-09-30 23:30|2026-09-30 00:00|false|true';
  for (const tz of ['UTC', 'America/Sao_Paulo', 'Europe/Berlin', 'Asia/Tokyo']) {
    let saida = '';
    try {
      saida = execFileSync(process.execPath, ['-e', codigo], {
        cwd: require('path').resolve(__dirname, '..'),
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      }).trim();
    } catch (e) { saida = `ERRO: ${e.message}`; }
    eq(saida, esperado, `⚠️ §7 mesma resposta em TZ=${tz}`);
  }
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ briefingCobre: todos os casos passaram');
