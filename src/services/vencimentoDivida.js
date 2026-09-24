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

  // ── A DATA DO BANCO VENCE A DERIVAÇÃO POR CALENDÁRIO (migration 154) ────
  //
  // Relato: "a próxima parcela vence dia 06 de OUTUBRO" contra "em 2 dias"
  // na tela. O resto desta função deriva a data do calendário — a próxima
  // ocorrência do dia N que ainda não passou —, que é o melhor possível numa
  // dívida lançada à mão e errado numa do Open Finance: lá o emissor conhece
  // o cronograma e a Sora não registra pagamento nenhum.
  //
  // ⚠️ ANTECIPAÇÃO é o caso que o calendário nunca acerta — e a primeira
  // tentativa de resolver isso também errou, por supor que as parcelas pagas
  // fossem as N PRIMEIRAS. No Nubank a antecipação amortiza pelo FIM: 8 pagas
  // de 36 eram os índices 0, 1 e 30..35. Quem calcula a data é
  // `proximaParcelaAberta` no sync (menor índice em aberto); aqui só se
  // CONSOME o resultado.
  //
  // ⚠️ Só vale enquanto a data NÃO PASSOU. Cronograma de banco envelhece (sync
  // parado, parcela vencida e não paga), e exibir data no passado como "a
  // próxima" seria pior do que voltar a derivar do calendário.
  const doBanco = divida && divida.proximo_vencimento
    ? String(divida.proximo_vencimento).slice(0, 10)
    : null;
  if (doBanco && doBanco >= hoje) {
    return { data: doBanco, dias: diffDias(hoje, doBanco), quitadaNoCiclo: false, fonte: 'banco' };
  }

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

/**
 * A parcela DESTE MÊS já venceu e não foi paga? — é o que grava (e agora
 * também APAGA) o `status = 'em_atraso'` da dívida.
 *
 * ⚠️ DIFERENTE DE `emAtraso`: aquela só afirma atraso com um pagamento
 * registrado como prova (a dívida do Open Finance não tem nenhum). Esta é a
 * regra do CRON de lembrete, que sempre marcou atraso pelo calendário — só que
 * ele tinha três defeitos, e todos viravam selo "EM ATRASO" errado no card:
 *   1. comparava a DATA do pagamento com o vencimento (`pago < venc`): quem
 *      pagou dia 7 a parcela do dia 10 virava "atrasado" no dia 11;
 *   2. ignorava `data_inicio`: dívida cadastrada depois do vencimento do mês
 *      já nascia atrasada;
 *   3. a flag era de MÃO ÚNICA — mudar o dia de vencimento (relato: "mudei do
 *      15 pro 20 e continua em atraso") não a tirava nunca.
 * Aqui o pagamento conta pela parcela que ele QUITOU (`vencimentoCoberto`), a
 * mesma regra do card.
 *
 * Só do backend (não tem espelho no front): o painel lê a coluna `status`.
 */
function vencidaNoMes(divida, hoje = hojeSP()) {
  const dia = Number(divida && divida.dia_vencimento);
  if (!dia || dia < 1 || dia > 31) return false;
  if (divida.status === 'quitada') return false;
  const total = Number(divida.parcelas_total) || 0;
  if (total > 0 && (Number(divida.parcelas_pagas) || 0) >= total) return false;

  const { Y, M } = partes(hoje);
  const venc = ocorrencia(Y, M, dia);
  if (venc >= hoje) return false;                    // ainda não venceu (hoje = "vence hoje")
  if (divida.data_inicio && venc <= String(divida.data_inicio).slice(0, 10)) return false;
  // Data do banco (migration 154) pra frente = o emissor diz que não venceu.
  if (divida.proximo_vencimento && String(divida.proximo_vencimento).slice(0, 10) > venc) return false;

  const pago = divida.ultimo_pagamento ? String(divida.ultimo_pagamento).slice(0, 10) : null;
  if (pago && vencimentoCoberto(pago, dia) >= venc) return false;
  return true;
}

/**
 * O status que a dívida deve ter AGORA, partindo do atual. Só alterna entre
 * 'ativa' e 'em_atraso' — 'quitada' (ou outro valor) nunca é mexido aqui.
 */
function statusDeAtraso(divida, hoje = hojeSP()) {
  const atual = divida && divida.status;
  if (atual !== 'ativa' && atual !== 'em_atraso') return atual;
  return vencidaNoMes(divida, hoje) ? 'em_atraso' : 'ativa';
}


/**
 * A divida deveria estar QUITADA pelas parcelas? Devolve 'quitada', 'ativa'
 * ou null (= nao da pra dizer, nao mexa).
 *
 * ⚠️ Relato de set/2026: o cliente quitou uma parcela sem querer, editou
 * baixando as parcelas pagas de 3 para 2, e o card CONTINUOU "Quitada". O
 * POST sempre recalculou o status pelas parcelas; o PUT nunca. E o
 * `statusDeAtraso` acima nao cobre isso de proposito: ele so anda entre
 * 'ativa' e 'em_atraso' e devolve 'quitada' intacta.
 *
 * ⚠️ SEM `parcelas_total` DEVOLVE null. Divida sem parcelas e quitada pelo
 * botao "quitar tudo", e responder 'ativa' aqui desquitaria todas elas na
 * primeira edicao — inclusive numa troca de titulo.
 */
function statusPorParcelas(divida) {
  const total = parseInt(divida && divida.parcelas_total, 10) || 0;
  if (total <= 0) return null;
  const pagas = parseInt(divida && divida.parcelas_pagas, 10) || 0;
  return pagas >= total ? 'quitada' : 'ativa';
}

module.exports = {
  proximoVencimento, vencimentoCoberto, ocorrencia, diffDias, ultimoDiaDoMes, hojeSP,
  ultimoPagamentoPorDivida, emAtraso, vencidaNoMes, statusDeAtraso, statusPorParcelas,
};
