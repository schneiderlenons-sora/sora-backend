// =============================================================================
// "Esta recorrência vence HOJE?" — aritmética canônica de frequência.
//
// ⚠️ ISTO DECIDE LANÇAMENTO AUTOMÁTICO DE DINHEIRO. Errar aqui não estoura: faz
// a Sora debitar a conta de alguém no dia errado, ou deixar de debitar e o
// saldo do painel divergir do banco em silêncio.
//
// ⚠️ ANTES, A DECISÃO MORAVA NA QUERY DO CRON: ele fazia
// `.in('dia_vencimento', diasAlvo)`, ou seja, o banco filtrava. Isso funcionava
// enquanto TODA recorrência era mensal — e é exatamente por isso que semanal e
// anual não podiam existir: elas nunca seriam carregadas. A decisão subiu pra
// cá; a query passa a trazer as ativas e quem julga é esta função.
//
// REGRESSÃO ZERO É REQUISITO. Recorrência sem `frequencia` (todas as que já
// existem) é tratada como mensal, e o resultado tem de ser IDÊNTICO ao da regra
// antiga — inclusive o clamp de fim de mês. O eval compara os dois lado a lado.
// =============================================================================

/** Último dia do mês (1..12 em `mes`). */
function ultimoDiaDoMes(ano, mes) {
  return new Date(ano, mes, 0).getDate();
}

/** Partes de 'YYYY-MM-DD'. */
function partes(iso) {
  const [ano, mes, dia] = String(iso).slice(0, 10).split('-').map(Number);
  return { ano, mes, dia };
}

/**
 * Dia da semana de 'YYYY-MM-DD' (0 = domingo … 6 = sábado).
 *
 * ⚠️ Construído por PARTES, nunca `new Date('YYYY-MM-DD')` — essa forma é
 * interpretada como UTC, e no Brasil devolveria o dia anterior.
 */
function diaDaSemana(iso) {
  const { ano, mes, dia } = partes(iso);
  return new Date(ano, mes - 1, dia).getDay();
}

/**
 * O dia do mês bate, com o CLAMP de fim de mês.
 *
 * ⚠️ O CLAMP É A REGRA ANTIGA, PRESERVADA AO PÉ DA LETRA. Conta marcada pro dia
 * 31 tem de cair em 28/02; sem isso ela simplesmente não aconteceria nos meses
 * curtos — e a pessoa descobriria pelo boleto vencido, não pelo app.
 */
function diaBate(diaVenc, hojeStr) {
  const { ano, mes, dia } = partes(hojeStr);
  const alvo = Number(diaVenc);
  if (!alvo || alvo < 1 || alvo > 31) return false;
  if (alvo === dia) return true;
  // Hoje é o último dia do mês e o alvo passou dele → cai hoje.
  const ultimo = ultimoDiaDoMes(ano, mes);
  return dia === ultimo && alvo > ultimo;
}

/**
 * A recorrência já terminou?
 *
 * ⚠️ `data_fim` é a fonte, não uma contagem de ocorrências. Contador precisaria
 * ser incrementado a cada lançamento e sair de sincronia é questão de tempo —
 * um restart no meio do laço, um lançamento manual, um restore de backup. A
 * data é imutável depois de escrita e não depende de o cron ter rodado.
 */
function jaTerminou(rec, hojeStr) {
  const fim = rec && rec.data_fim ? String(rec.data_fim).slice(0, 10) : null;
  return !!fim && String(hojeStr).slice(0, 10) > fim;
}

/**
 * Vence hoje?
 *
 * `rec` precisa de: `frequencia`, `dia_vencimento`, `dia_semana`,
 * `mes_vencimento`, `data_fim`, `data_inicio`.
 */
function venceHoje(rec, hojeStr) {
  if (!rec) return false;
  if (jaTerminou(rec, hojeStr)) return false;

  // Recorrência criada hoje pra frente não pode disparar retroativo.
  const inicio = rec.data_inicio ? String(rec.data_inicio).slice(0, 10) : null;
  if (inicio && String(hojeStr).slice(0, 10) < inicio) return false;

  // ⚠️ SEM `frequencia` = MENSAL. É o estado de toda recorrência que já existe
  // na base, e o default preserva o comportamento delas byte a byte.
  const freq = rec.frequencia || 'mensal';

  if (freq === 'semanal') {
    const alvo = Number(rec.dia_semana);
    if (!Number.isInteger(alvo) || alvo < 0 || alvo > 6) return false;
    return diaDaSemana(hojeStr) === alvo;
  }

  if (freq === 'anual') {
    const { mes } = partes(hojeStr);
    if (Number(rec.mes_vencimento) !== mes) return false;
    return diaBate(rec.dia_vencimento, hojeStr);
  }

  return diaBate(rec.dia_vencimento, hojeStr);
}

/**
 * Data em que a recorrência deve PARAR, a partir do número de repetições.
 *
 * Devolve `null` para "sempre" — e null é o default, então nada muda para quem
 * já existe.
 */
function calcularDataFim({ frequencia, repeticoes, dataInicio, diaVencimento }) {
  const n = Number(repeticoes);
  if (!Number.isFinite(n) || n <= 0) return null;      // sempre

  const base = String(dataInicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const { ano, mes, dia } = partes(base);
  const freq = frequencia || 'mensal';

  // A ÚLTIMA ocorrência é a de índice n-1 a partir do início.
  const passos = n - 1;

  if (freq === 'semanal') {
    const d = new Date(ano, mes - 1, dia + passos * 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const mesesAdiante = freq === 'anual' ? passos * 12 : passos;
  const total = (ano * 12) + (mes - 1) + mesesAdiante;
  const anoFim = Math.floor(total / 12);
  const mesFim = (total % 12) + 1;
  // Mesmo clamp do disparo: dia 31 em fevereiro vira o último dia.
  const alvo = Number(diaVencimento) || dia;
  const diaFim = Math.min(alvo, ultimoDiaDoMes(anoFim, mesFim));
  return `${anoFim}-${String(mesFim).padStart(2, '0')}-${String(diaFim).padStart(2, '0')}`;
}

/**
 * O lembrete desta recorrência sai hoje?
 *
 * `lembrete_dias` = quantos dias ANTES avisar. 0 (ou ausente) = no próprio dia,
 * que é o comportamento de hoje.
 */
function lembreteHoje(rec, hojeStr) {
  if (!rec || rec.lembrete === false) return false;
  const dias = Number(rec.lembrete_dias) || 0;
  if (dias <= 0) return venceHoje(rec, hojeStr);

  const { ano, mes, dia } = partes(hojeStr);
  const alvo = new Date(ano, mes - 1, dia + dias);
  const alvoStr = `${alvo.getFullYear()}-${String(alvo.getMonth() + 1).padStart(2, '0')}-${String(alvo.getDate()).padStart(2, '0')}`;
  return venceHoje(rec, alvoStr);
}

module.exports = {
  venceHoje, lembreteHoje, calcularDataFim, jaTerminou,
  diaBate, diaDaSemana, ultimoDiaDoMes,
};
