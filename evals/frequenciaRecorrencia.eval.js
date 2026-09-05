// =============================================================================
// EVAL da frequência de recorrências.
//
// ⚠️ ISTO DECIDE LANÇAMENTO AUTOMÁTICO DE DINHEIRO. A regra saiu da QUERY do
// cron (`.in('dia_vencimento', diasAlvo)`) e virou função — e a §1 existe pra
// provar que a mudança não move NENHUMA recorrência que já existe.
//
// Rodar:  npm run eval:frequencia
// =============================================================================
const {
  venceHoje, lembreteHoje, calcularDataFim, ultimoDiaDoMes,
} = require('../src/services/frequenciaRecorrencia');

const falhas = [];
const eq = (a, b, m) => {
  if (a === b) return;
  falhas.push(`${m}\n      esperado: ${JSON.stringify(b)}\n      recebido: ${JSON.stringify(a)}`);
};

/**
 * A REGRA ANTIGA, copiada do cron antes da mudança, pra comparar lado a lado.
 * Ela montava `diasAlvo` e deixava o banco filtrar por `dia_vencimento`.
 */
function regraAntiga(diaVencimento, hojeStr) {
  const [ySP, mSP] = hojeStr.split('-').map(Number);
  const diaHojeSP = parseInt(hojeStr.slice(8, 10), 10);
  const diasNoMes = new Date(ySP, mSP, 0).getDate();
  const diasAlvo = [diaHojeSP];
  if (diaHojeSP === diasNoMes) for (let d = diaHojeSP + 1; d <= 31; d++) diasAlvo.push(d);
  return diasAlvo.includes(Number(diaVencimento));
}

// ── 1. REGRESSÃO ZERO — o teste que autoriza a mudança ──────────────────────
console.log('── 1. mensal: idêntico à regra antiga ──');
{
  // Todo dia de 2026 × todo dia de vencimento de 1 a 31.
  let comparados = 0;
  let divergentes = 0;
  for (let mes = 1; mes <= 12; mes += 1) {
    const ultimo = ultimoDiaDoMes(2026, mes);
    for (let dia = 1; dia <= ultimo; dia += 1) {
      const hoje = `2026-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      for (let venc = 1; venc <= 31; venc += 1) {
        const antiga = regraAntiga(venc, hoje);
        // Sem `frequencia` — exatamente como as linhas que já existem no banco.
        const nova = venceHoje({ dia_vencimento: venc }, hoje);
        comparados += 1;
        if (antiga !== nova) {
          divergentes += 1;
          if (divergentes <= 3) {
            falhas.push(`divergiu em ${hoje} com vencimento ${venc}: antiga=${antiga} nova=${nova}`);
          }
        }
      }
    }
  }
  eq(divergentes, 0, `${comparados} combinações comparadas, nenhuma pode divergir`);
  console.log(`  ${comparados} combinações · ${divergentes} divergências`);
}
console.log('  ok');

// ── 2. Clamp de fim de mês ──────────────────────────────────────────────────
console.log('── 2. clamp de fim de mês ──');
{
  eq(venceHoje({ dia_vencimento: 31 }, '2026-02-28'), true, 'dia 31 cai em 28/02');
  eq(venceHoje({ dia_vencimento: 30 }, '2026-02-28'), true, 'dia 30 também');
  eq(venceHoje({ dia_vencimento: 28 }, '2026-02-28'), true, 'e o dia 28 normalmente');
  eq(venceHoje({ dia_vencimento: 31 }, '2026-02-27'), false, 'mas NÃO no dia 27');
  eq(venceHoje({ dia_vencimento: 31 }, '2026-03-31'), true, 'março tem dia 31');
  eq(venceHoje({ dia_vencimento: 31 }, '2026-04-30'), true, 'abril clampa no 30');
  eq(venceHoje({ dia_vencimento: 1 },  '2026-04-30'), false, 'e o dia 1 não vaza pro fim do mês');
}
console.log('  ok');

// ── 3. Semanal ──────────────────────────────────────────────────────────────
console.log('── 3. semanal ──');
{
  // 2026-09-07 é uma segunda-feira.
  const seg = { frequencia: 'semanal', dia_semana: 1 };
  eq(venceHoje(seg, '2026-09-07'), true,  'cai na segunda');
  eq(venceHoje(seg, '2026-09-14'), true,  'e na segunda seguinte');
  eq(venceHoje(seg, '2026-09-08'), false, 'não na terça');
  eq(venceHoje({ frequencia: 'semanal', dia_semana: 0 }, '2026-09-06'), true, 'domingo é 0');
  eq(venceHoje({ frequencia: 'semanal' }, '2026-09-07'), false, 'semanal sem dia_semana não dispara');
}
console.log('  ok');

// ── 4. Anual ────────────────────────────────────────────────────────────────
console.log('── 4. anual ──');
{
  const ipva = { frequencia: 'anual', mes_vencimento: 3, dia_vencimento: 10 };
  eq(venceHoje(ipva, '2026-03-10'), true,  'cai em 10/03');
  eq(venceHoje(ipva, '2027-03-10'), true,  'e no ano seguinte');
  eq(venceHoje(ipva, '2026-04-10'), false, 'não em abril');
  eq(venceHoje(ipva, '2026-03-11'), false, 'nem no dia seguinte');
  // Clamp vale no anual também.
  eq(venceHoje({ frequencia: 'anual', mes_vencimento: 2, dia_vencimento: 30 }, '2026-02-28'),
    true, 'anual dia 30 de fevereiro clampa no 28');
}
console.log('  ok');

// ── 5. Duração — `data_fim` encerra ─────────────────────────────────────────
console.log('── 5. duração ──');
{
  const r = { dia_vencimento: 10, data_fim: '2026-12-10' };
  eq(venceHoje(r, '2026-12-10'), true,  'o último dia AINDA vale');
  eq(venceHoje(r, '2027-01-10'), false, 'depois dele, não');
  eq(venceHoje({ dia_vencimento: 10 }, '2030-01-10'), true, 'sem data_fim é pra sempre');
}
console.log('  ok');

// ── 6. `calcularDataFim` ────────────────────────────────────────────────────
console.log('── 6. cálculo da data final ──');
{
  eq(calcularDataFim({ frequencia: 'mensal', repeticoes: 12, dataInicio: '2026-09-10', diaVencimento: 10 }),
    '2027-08-10', '12x mensal a partir de set/26 termina em ago/27');
  eq(calcularDataFim({ frequencia: 'mensal', repeticoes: 1, dataInicio: '2026-09-10', diaVencimento: 10 }),
    '2026-09-10', '1x é o próprio mês');
  eq(calcularDataFim({ frequencia: 'semanal', repeticoes: 4, dataInicio: '2026-09-07' }),
    '2026-09-28', '4x semanal são 3 semanas à frente');
  eq(calcularDataFim({ frequencia: 'anual', repeticoes: 3, dataInicio: '2026-03-10', diaVencimento: 10 }),
    // 3 ocorrências a partir de 2026 são 2026, 2027 e 2028 — a última é a
    // TERCEIRA, não a de daqui a três anos. Escrevi 2029 na primeira versão e o
    // eval me corrigiu.
    '2028-03-10', '3x anual: 2026, 2027 e 2028');
  eq(calcularDataFim({ repeticoes: 0, dataInicio: '2026-09-10' }), null, '0 = sempre');
  eq(calcularDataFim({ repeticoes: null, dataInicio: '2026-09-10' }), null, 'null = sempre');
  // ⚠️ O clamp também vale na data final: 31 de janeiro + 1 mês não é 03/03.
  eq(calcularDataFim({ frequencia: 'mensal', repeticoes: 2, dataInicio: '2026-01-31', diaVencimento: 31 }),
    '2026-02-28', 'a data final clampa em fevereiro');
}
console.log('  ok');

// ── 7. Não dispara antes de começar ─────────────────────────────────────────
console.log('── 7. data de início ──');
{
  const r = { dia_vencimento: 10, data_inicio: '2026-10-01' };
  eq(venceHoje(r, '2026-09-10'), false, 'antes do início não dispara');
  eq(venceHoje(r, '2026-10-10'), true,  'a partir dele, sim');
}
console.log('  ok');

// ── 8. Antecedência do lembrete ─────────────────────────────────────────────
console.log('── 8. lembrete com antecedência ──');
{
  const r = { dia_vencimento: 10, lembrete_dias: 3 };
  eq(lembreteHoje(r, '2026-09-07'), true,  '3 dias antes do dia 10');
  eq(lembreteHoje(r, '2026-09-10'), false, 'e NÃO no próprio dia');
  eq(lembreteHoje({ dia_vencimento: 10 }, '2026-09-10'), true, 'sem antecedência, avisa no dia');
  eq(lembreteHoje({ dia_vencimento: 10, lembrete: false }, '2026-09-10'), false, 'lembrete desligado não avisa');
  // Atravessa o mês: 2 dias antes do dia 1 de outubro é 29/09.
  eq(lembreteHoje({ dia_vencimento: 1, lembrete_dias: 2 }, '2026-09-29'), true,
    'a antecedência atravessa o mês');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.slice(0, 10).forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ frequência de recorrência: todos os casos passaram');
