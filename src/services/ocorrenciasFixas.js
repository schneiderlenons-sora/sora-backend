// =============================================================================
// QUANDO CADA CONTA FIXA CAI NUM PERÍODO — e em que ESTADO — fonte única.
//
// Usada pelo "o que tenho pra pagar" do WhatsApp (services/aPagarPeriodo.js) e
// pela Agenda do painel (services/agendaFeed.js). Antes a Agenda tinha a sua
// própria conta — só o dia do vencimento, mês a mês — e por isso mostrava
// "a pagar" uma conta já paga (relato do Fábio, out/2026: Internet da Claro
// paga antes do dia 25 seguia na Agenda como pendente). Medido em 26/10/2026:
// as 362 contas fixas pagas em outubro apareciam TODAS como em aberto.
//
// Cada ocorrência sai com um estado:
//   · 'aberta' — vence no dia e ainda não foi resolvida;
//   · 'paga'   — já tem baixa naquele mês (transação com `recorrencia_id` +
//                `competencia`, migration 165).
// A PULADA (`previsao_ajustes.status = 'pulado'`) não sai — naquele mês ela
// não acontece. A ADIADA (`'movido'`) sai na DATA NOVA, com `adiada: true`, e
// some da data original.
//
// ⚠️ A REGRA DE DATAS É A DO CRON (`venceHoje`): frequência semanal/anual,
// início e fim. A Agenda antiga tratava TODA conta como mensal — mostrava a
// semanal uma vez por mês e a conta encerrada ("repetir 10 vezes") pra sempre.
//
// ⚠️ SEMANAL NÃO OLHA BAIXA: tem várias ocorrências no mês e a chave da baixa é
// MENSAL (`recorrencia_id` + `competencia`) — uma baixa marcaria as quatro
// semanas. Nela só o calendário vale (mesma decisão de `resolvidasNoMes`).
//
// Puro: não toca no banco. Travado em `eval:ocorrencias-fixas`, que também
// compara o "a pagar" com uma cópia congelada da lógica que vivia lá.
// =============================================================================

const { venceHoje } = require('./frequenciaRecorrencia');

const DIA_MS = 864e5;

function somarDias(iso, n) {
  const [Y, M, D] = iso.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D) + n * DIA_MS).toISOString().slice(0, 10);
}

/** Dias de [de, ate], com teto (o mesmo laço que o "a pagar" sempre usou). */
function diasEntre(de, ate, maxDias) {
  const out = [];
  for (let d = de; d <= ate && out.length <= maxDias; d = somarDias(d, 1)) out.push(d);
  return out;
}

const chave = (recId, comp) => `${recId}|${comp}`;

/**
 * @param {object} dados
 *   recorrencias [{ id, tipo, descricao, valor, valor_variavel, dia_vencimento,
 *                  frequencia, dia_semana, mes_vencimento, data_inicio, data_fim }]
 *   vinculadas   [{ recorrencia_id, competencia }] — baixas (transação ligada)
 *   ajustes      [{ recorrencia_id, competencia, status, nova_data, novo_valor }]
 * @param {{ de: string, ate: string }} janela  'YYYY-MM-DD' inclusivo
 * @param {{ maxDias?: number }} [opcoes]
 * @returns {Array<{ rec, data, competencia, estado: 'aberta'|'paga',
 *                   valor: number|null, valorAjustado: number|null, adiada: boolean }>}
 *   Ordem: as do calendário (por recorrência, por dia) e depois as adiadas.
 */
function ocorrenciasDeFixas(dados, janela, opcoes = {}) {
  const { de, ate } = janela;
  const maxDias = Number(opcoes.maxDias) > 0 ? Number(opcoes.maxDias) : 123;
  const out = [];
  const dentro = (d) => d && d >= de && d <= ate;

  const vinc = new Set((dados.vinculadas || []).map((v) => chave(v.recorrencia_id, v.competencia)));
  const ajuste = new Map((dados.ajustes || []).map((a) => [chave(a.recorrencia_id, a.competencia), a]));
  const recs = dados.recorrencias || [];
  const dias = diasEntre(de, ate, maxDias);

  // 1. As ocorrências do calendário.
  for (const r of recs) {
    const semanal = (r.frequencia || 'mensal') === 'semanal';
    for (const d of dias) {
      if (!venceHoje(r, d)) continue;
      const comp = d.slice(0, 7);
      let estado = 'aberta';
      let valorAjustado = null;
      if (!semanal) {
        const aj = ajuste.get(chave(r.id, comp));
        if (aj?.status === 'pulado') continue;
        if (aj?.status === 'movido') continue;   // sai na data nova (passo 2)
        if (vinc.has(chave(r.id, comp))) estado = 'paga';
        // Valor ajustado no Extrato só pra ESTA ocorrência (migration 181).
        if (aj?.status === 'valor' && Number(aj.novo_valor) > 0) valorAjustado = Number(aj.novo_valor);
      }
      out.push({
        rec: r, data: d, competencia: comp, estado,
        valor: Number(r.valor) > 0 ? Number(r.valor) : null,
        valorAjustado, adiada: false,
      });
    }
  }

  // 2. As ADIADAS: aparecem na data nova, se ela cair no período.
  const recPorId = new Map(recs.map((r) => [r.id, r]));
  for (const a of dados.ajustes || []) {
    if (a.status !== 'movido') continue;
    const d = String(a.nova_data || '').slice(0, 10);
    if (!dentro(d)) continue;
    const r = recPorId.get(a.recorrencia_id);
    if (!r) continue;
    const v = Number(a.novo_valor) > 0 ? Number(a.novo_valor) : Number(r.valor);
    out.push({
      rec: r, data: d, competencia: a.competencia,
      estado: vinc.has(chave(r.id, a.competencia)) ? 'paga' : 'aberta',
      valor: v > 0 ? v : null, valorAjustado: null, adiada: true,
    });
  }

  return out;
}

module.exports = { ocorrenciasDeFixas };
