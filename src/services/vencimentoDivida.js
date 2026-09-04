// =====================================================================
// Próximo vencimento de uma DÍVIDA — fonte única da regra.
//
// BUG QUE ISTO CORRIGE: o card dizia "Próxima parcela em 3 dias" mesmo
// DEPOIS do usuário pagar a parcela daquele mês. A regra antiga só olhava
// `dia_vencimento` e o calendário — nunca o pagamento. Quem pagou dia 7 uma
// parcela que vence dia 10 continuava vendo (e recebendo no WhatsApp) o
// aviso da parcela que acabou de quitar.
//
// A regra tinha 5 cópias divergentes (card, resumo do painel, SSR, cron de
// lembrete e agenda). Agora a aritmética mora aqui e é espelhada FIELMENTE em
// `sora-frontend/lib/vencimento-divida.ts` — mexeu num, mexa no outro e rode
// os DOIS evals (`npm run eval:vencimento-divida`).
//
// Tudo em string 'YYYY-MM-DD': comparação é lexicográfica e não existe fuso
// pra errar (`toISOString()` é UTC — às 21h no BR já virou o dia seguinte).
// =====================================================================

const DIA_MS = 86400000;

function partes(iso) {
  const [Y, M, D] = String(iso).slice(0, 10).split('-').map(Number);
  return { Y, M: M - 1, D };
}

/** Último dia do mês (Y, M) — M pode estar fora de 0..11 que o Date normaliza. */
function ultimoDiaDoMes(Y, M) {
  return new Date(Date.UTC(Y, M + 1, 0)).getUTCDate();
}

/**
 * Ocorrência do dia `dia` no mês (Y, M), CLAMPADA ao último dia do mês.
 * Dívida que vence dia 31 vence em 28/02 — nunca "03/03" (que é o que
 * `new Date(Y, 1, 31)` devolve por rollover, o bug da regra antiga).
 */
function ocorrencia(Y, M, dia) {
  const base = new Date(Date.UTC(Y, M, 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = Math.min(Math.max(1, dia), ultimoDiaDoMes(y, m));
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Dias inteiros de `a` até `b` (b − a). Negativo = b no passado. */
function diffDias(a, b) {
  const A = partes(a); const B = partes(b);
  return Math.round((Date.UTC(B.Y, B.M, B.D) - Date.UTC(A.Y, A.M, A.D)) / DIA_MS);
}

/** Hoje no fuso de São Paulo, 'YYYY-MM-DD' ('en-CA' já formata assim). */
function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Qual vencimento aquele pagamento quitou.
 *
 * É a ocorrência de `dia` MAIS PRÓXIMA da data do pagamento — não a anterior
 * nem a seguinte por regra fixa. É o que separa "paguei a de agosto adiantado
 * (dia 7, vence 10)" de "paguei a de julho atrasado (dia 12, venceu 10)":
 * ambos são o vencimento que está a poucos dias dali. Empate fica com a
 * ocorrência ANTERIOR (pagar no meio do caminho é quitar a que já venceu).
 */
function vencimentoCoberto(pagamento, dia) {
  const { Y, M } = partes(pagamento);
  let melhor = null;
  let menor = Infinity;
  for (const k of [-1, 0, 1]) {                 // ascendente: empate fica na 1ª (anterior)
    const cand = ocorrencia(Y, M + k, dia);
    const dist = Math.abs(diffDias(cand, pagamento));
    if (dist < menor) { menor = dist; melhor = cand; }
  }
  return melhor;
}

/**
 * Próximo vencimento da dívida.
 *
 * @param divida  { dia_vencimento, data_inicio, status, ultimo_pagamento }
 *                `ultimo_pagamento` = 'YYYY-MM-DD' do último pagamento de
 *                PARCELA registrado (juros de atraso não conta — não anda
 *                parcela). Ausente = sem histórico: cai no comportamento
 *                antigo, que é o certo pras dívidas do Open Finance (a
 *                contagem de pagas vem do banco, sem pagamento na Sora).
 * @param hoje    'YYYY-MM-DD' (backend: hojeSP(); front: data local).
 * @returns {{ data: string, dias: number, quitadaNoCiclo: boolean } | null}
 */
function proximoVencimento(divida, hoje = hojeSP()) {
  const dia = Number(divida && divida.dia_vencimento);
  if (!dia || dia < 1 || dia > 31) return null;
  if (divida.status === 'quitada') return null;

  // ⚠️ AQUI MOROU UMA REGRESSÃO — ler antes de tentar de novo.
  //
  // A ideia era: dívida do Open Finance tem o cronograma no emissor, então a
  // data dele deveria vencer a derivação por calendário. A ideia continua de
  // pé; a DERIVAÇÃO é que estava errada. Calculei
  // `first_instalment_due_date + paid_instalments meses` e num contrato com
  // 1ª parcela em 06/08/2026 e 8 "pagas" isso deu 06/04/2027: o card passou a
  // anunciar "próxima parcela em 214 dias" onde o banco diz 06/10 — erro MAIOR
  // que o bug original, que era de um mês.
  //
  // Ou seja, `paid_instalments` NÃO é "quantas parcelas do cronograma já
  // foram liquidadas". Antes de religar isto é preciso ver o payload real
  // (/api/admin/of-debug com foco=dividas) e descobrir o que ele conta — a doc
  // também expõe `payments.releases[]` com `paidDate` e `isOverParcelPayment`,
  // o que sugere contagem de PAGAMENTOS, não de parcelas.
  //
  // Até lá vale o calendário abaixo, que erra por semanas e não por meses.

  const { Y, M } = partes(hoje);

  // 1) Próxima ocorrência que ainda não passou (hoje conta como "vence hoje").
  let k = 0;
  let venc = ocorrencia(Y, M, dia);
  if (venc < hoje) { k = 1; venc = ocorrencia(Y, M + k, dia); }

  // 2) A 1ª parcela nunca vence no mês da compra: se cair em/antes do
  //    `data_inicio`, pula pro mês seguinte. (Parcelou hoje dia 27 → 1ª
  //    parcela dia 27 do mês que vem, não amanhã.)
  if (divida.data_inicio && venc <= String(divida.data_inicio).slice(0, 10)) {
    k += 1;
    venc = ocorrencia(Y, M + k, dia);
  }

  // 3) O pagamento já cobriu essa parcela? Então a próxima é a seguinte.
  //    Só ANDA pra frente: pagamento antigo nunca joga o vencimento pro
  //    passado (quem está atrasado continua vendo a próxima data real, sem
  //    regressão pra quem registrou um pagamento uma vez e parou).
  let quitadaNoCiclo = false;
  const pago = divida.ultimo_pagamento ? String(divida.ultimo_pagamento).slice(0, 10) : null;
  if (pago) {
    const coberta = vencimentoCoberto(pago, dia);
    if (coberta >= venc) {
      const c = partes(coberta);
      venc = ocorrencia(c.Y, c.M + 1, dia);
      quitadaNoCiclo = true;
    }
  }

  return { data: venc, dias: diffDias(hoje, venc), quitadaNoCiclo };
}

/**
 * Data do último pagamento de PARCELA de cada dívida: `{ [divida_id]: 'YYYY-MM-DD' }`.
 *
 * `juros_atraso` fica de fora de propósito: pagar juros não anda parcela, logo
 * não pode empurrar o vencimento. Uma query só pra lista inteira (o cron roda
 * isso pra toda a base — consulta por dívida seria N+1).
 *
 * `require` preguiçoso do supabase pra este módulo seguir importável sem env
 * (a aritmética acima é pura e o eval carrega só ela).
 */
async function ultimoPagamentoPorDivida(ids) {
  const lista = (ids || []).filter(Boolean);
  if (!lista.length) return {};
  const supabase = require('../db/supabase');
  const { data } = await supabase.from('divida_pagamentos')
    .select('divida_id, data_pagamento, tipo')
    .in('divida_id', lista)
    .neq('tipo', 'juros_atraso')
    .order('data_pagamento', { ascending: false });
  const mapa = {};
  for (const p of data || []) {
    const d = String(p.data_pagamento || '').slice(0, 10);
    if (!d) continue;
    if (!mapa[p.divida_id] || d > mapa[p.divida_id]) mapa[p.divida_id] = d;
  }
  return mapa;
}

/**
 * A dívida está ATRASADA hoje? — ou seja: existe uma parcela que JÁ VENCEU e
 * cujo pagamento nunca foi registrado.
 *
 * ⚠️ NÃO CONFUNDIR COM `proximoVencimento().quitadaNoCiclo`. Aquele responde
 * "o pagamento cobriu a parcela que ainda vai vencer", que só é verdade pra
 * quem pagou ADIANTADO. Usá-lo como teste de atraso deixava marcado quem pagou
 * NO DIA ou COM ATRASO — que são justamente os casos em que a pessoa acabou de
 * se acertar e olha pro badge esperando ver que se acertou.
 *
 * A comparação é entre duas ocorrências do mesmo `dia`:
 *   · `ultimaVencida` — a última que já passou (hoje conta como vencida);
 *   · `coberta`       — qual delas o último pagamento quitou
 *                        (`vencimentoCoberto`, a mesma regra do card).
 * Em dia quando `coberta >= ultimaVencida`.
 *
 * Sem pagamento registrado devolve `false`: é o caso de TODA dívida do Open
 * Finance (as parcelas pagas vêm do banco como contagem, não como registro), e
 * afirmar atraso sem prova nenhuma seria alarme falso.
 */
function emAtraso(divida, hoje = hojeSP()) {
  const dia = Number(divida && divida.dia_vencimento);
  if (!dia || dia < 1 || dia > 31) return false;
  if (divida.status === 'quitada') return false;

  const pago = divida.ultimo_pagamento ? String(divida.ultimo_pagamento).slice(0, 10) : null;
  if (!pago) return false;

  const { Y, M } = partes(hoje);
  let ultimaVencida = ocorrencia(Y, M, dia);
  if (ultimaVencida > hoje) ultimaVencida = ocorrencia(Y, M - 1, dia);

  // A 1ª parcela nunca vence no mês do contrato — antes disso não há atraso.
  if (divida.data_inicio && ultimaVencida <= String(divida.data_inicio).slice(0, 10)) return false;

  return vencimentoCoberto(pago, dia) < ultimaVencida;
}

module.exports = {
  proximoVencimento, vencimentoCoberto, ocorrencia, diffDias, ultimoDiaDoMes, hojeSP,
  ultimoPagamentoPorDivida, emAtraso,
};
