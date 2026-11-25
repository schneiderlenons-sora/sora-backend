// =============================================================================
// Fatura ATRASADA do cartão MANUAL — fonte única (nov/2026).
//
// Relato (Fábio, 16/11): a fatura do C6 venceu em 15/11 sem ser paga e a tela
// de cartões "pulou" pra fatura de dezembro como se a de novembro estivesse
// paga. A rota `/faturas` já calculava `vencida`, mas NENHUMA tela a lia; e o
// JOB 1L, em vez de mostrar a dívida, ROLAVA o saldo sozinho em 24h — e ainda
// quebrava antes de avisar (`row is not defined`, desde 10/08/2026), então 100
// faturas foram empurradas pra frente em silêncio.
//
// A regra agora (decisão do dono):
//   • fatura de cartão manual vencida e não paga aparece como ATRASADA até ser
//     paga;
//   • passar o saldo pra próxima fatura é ESCOLHA da pessoa (painel ou
//     "passar" no WhatsApp), com ou sem juros — nunca automático.
//   • Open Finance fica de fora: lá o próprio banco leva o saldo (com os juros
//     dele) pra fatura seguinte, e o valor vem do banco.
//
// Travado em `npm run eval:fatura-atrasada`.
// =============================================================================
const { competenciaAtual, competenciaVizinha, cicloPorCompetencia, hojeSP } = require('./cicloFatura');

/** Quantas faturas pra trás procurar. Mais que isso é histórico, não atraso. */
const MAX_CICLOS_ATRASO = 6;
/** Abaixo disso é arredondamento, não dívida. */
const TOLERANCIA = 0.01;

function diasEntre(de, ate) {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000);
}

/**
 * Situação de UMA fatura, pra tela dizer a verdade em vez de "Em aberto".
 * @returns {'rolada'|'paga'|'atrasada'|'em_aberto'}
 */
function situacaoDaFatura({ venc, hoje, restante, rolada = false, ehOF = false }) {
  if (rolada) return 'rolada';
  if (!(Number(restante) > TOLERANCIA)) return 'paga';
  if (!ehOF && venc && venc < hoje) return 'atrasada';
  return 'em_aberto';
}

/** Este cartão entra na regra de atraso? Só manual e com dia de vencimento. */
function cartaoTemAtraso(cartao) {
  return !!cartao && !cartao.of_conta_id && !!cartao.dia_vencimento;
}

/**
 * Faturas VENCIDAS e não pagas de um cartão manual, da mais recente pra mais
 * antiga.
 *
 * Para na primeira que:
 *   • foi passada pra frente (o saldo dela — e o das anteriores — já está na
 *     seguinte; contá-la de novo seria cobrar duas vezes);
 *   • está paga (é o caso de quem paga em dia: UMA consulta, igual a antes);
 *   • terminou antes de o cartão existir na Sora (histórico importado não é
 *     dívida que a pessoa deixou de pagar aqui).
 *
 * @param cartao   { id, of_conta_id, dia_fechamento, dia_vencimento }
 * @param opts.status   async (competencia) → { fatura, pago, restante }
 * @param opts.roladas  Set de competências já passadas pra frente
 * @param opts.criadoEm 'YYYY-MM-DD' em que o cartão foi criado (opcional)
 */
async function faturasAtrasadas(cartao, { hoje = hojeSP(), status, roladas = new Set(), criadoEm = null, max = MAX_CICLOS_ATRASO } = {}) {
  if (!cartaoTemAtraso(cartao) || typeof status !== 'function') return [];
  const out = [];
  let comp = competenciaVizinha(cartao, competenciaAtual(cartao, hoje), -1);
  for (let i = 0; i < max; i++) {
    const ciclo = cicloPorCompetencia(cartao, comp);
    if (ciclo.venc >= hoje) break; // defesa: não deveria acontecer
    if (criadoEm && (ciclo.ultimo || ciclo.fim) < criadoEm) break;
    if (roladas.has(comp)) break;
    const st = await status(comp);
    const restante = Math.round((Number(st && st.restante) || 0) * 100) / 100;
    if (!(restante > TOLERANCIA)) break;
    out.push({
      competencia: comp,
      venc: ciclo.venc,
      label: ciclo.label,
      fatura: Number(st.fatura) || 0,
      pago: Number(st.pago) || 0,
      restante,
      diasAtraso: diasEntre(ciclo.venc, hoje),
    });
    comp = competenciaVizinha(cartao, comp, -1);
  }
  return out;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
/** '2026-11' → 'novembro' (a fatura leva o nome do mês em que VENCE). */
function nomeDoMes(competencia) {
  const m = Number(String(competencia || '').slice(5, 7));
  return MESES[m - 1] || competencia;
}
/** '2026-11-15' → '15/11' */
function ddmm(dia) {
  return `${String(dia).slice(8, 10)}/${String(dia).slice(5, 7)}`;
}

/**
 * Texto do aviso no WhatsApp. ⚠️ "Você pagou parte" só quando pagou parte —
 * o texto antigo dizia isso pra quem não tinha pago nada (o caso do relato).
 */
function textoAvisoAtraso({ cartaoNome, competencia, venc, pago, restante, fmt }) {
  const mes = nomeDoMes(competencia);
  const situacao = pago > TOLERANCIA
    ? `Você pagou ${fmt(pago)} da fatura de ${mes} do ${cartaoNome} e ficaram *${fmt(restante)}* em aberto (venceu em ${ddmm(venc)}).`
    : `A fatura de ${mes} do ${cartaoNome} venceu em ${ddmm(venc)} e está em aberto: *${fmt(restante)}*.`;
  const texto =
    `💳 ${situacao}\n\n` +
    `Se você já pagou, registre o pagamento no painel pra ela sair dos atrasos.\n\n` +
    `Se não vai pagar agora, responda *passar* que eu levo esse valor pra próxima fatura.`;
  const core = pago > TOLERANCIA
    ? `Ficaram ${fmt(restante)} em aberto da fatura de ${mes} do ${cartaoNome} (venceu ${ddmm(venc)}). Já pagou? Registre no painel. Pra levar à próxima fatura, responda passar.`
    : `A fatura de ${mes} do ${cartaoNome} venceu ${ddmm(venc)} e está em aberto: ${fmt(restante)}. Já pagou? Registre no painel. Pra levar à próxima fatura, responda passar.`;
  return { texto, core };
}

/** Juros digitado: número ≥ 0 com no máximo 2 casas, ou erro. */
function validarJuros(juros) {
  if (juros == null || juros === '') return { ok: true, valor: 0 };
  const v = Number(juros);
  if (!Number.isFinite(v) || v < 0) return { ok: false, erro: 'Informe um valor de juros válido (zero ou mais).' };
  if (v > 1e7) return { ok: false, erro: 'Valor de juros alto demais.' };
  return { ok: true, valor: Math.round(v * 100) / 100 };
}

module.exports = {
  MAX_CICLOS_ATRASO, TOLERANCIA,
  situacaoDaFatura, cartaoTemAtraso, faturasAtrasadas,
  nomeDoMes, ddmm, textoAvisoAtraso, validarJuros, diasEntre,
};
