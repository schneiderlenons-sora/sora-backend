// =============================================================================
// "ESTA CONTA FIXA JÁ FOI RESOLVIDA NESTE MÊS?" — fonte única.
//
// Resolvida = já PAGA (existe transação amarrada à recorrência na competência
// do mês) ou PULADA (`previsao_ajustes.status = 'pulado'`). Nos dois casos ela
// não deve mais aparecer como "ainda vai vencer", nem ser relançada.
//
// ⚠️ POR QUE EXISTE: a regra nasceu dentro do cron (JOB 1A), que relançava
// conta já resolvida. Ela NÃO foi propagada pros outros dois lugares que
// respondem a mesma pergunta, e o resultado foi o relato de set/2026: o
// cliente pagou luz, gás e internet no dia 21 — ANTES do vencimento (25, 26 e
// 28) — e as três continuaram aparecendo no card "Ainda vence este mês" do
// painel E no "📌 Ainda neste mês" do resumo do WhatsApp. As transações
// estavam corretas no banco (com `recorrencia_id` + `competencia`); quem não
// perguntava eram as duas telas. Era a 3ª cópia divergente da mesma regra —
// por isso agora ela mora aqui, e os três chamam o mesmo lugar.
//
// ⚠️ SEMANAL FICA DE FORA: tem várias ocorrências no mesmo mês e a chave é
// mensal (recorrencia_id + competencia) — a 1ª semana bloquearia as seguintes.
//
// ⚠️ TOLERANTE POR DESIGN: se a leitura falhar, devolve conjunto VAZIO e o
// chamador se comporta como antes (mostra/lança). Falhar para o lado de
// ESCONDER sumiria com a conta fixa de todo mundo sem ninguém entender por quê.
// =============================================================================
const supabase = require('../db/supabase');

/**
 * @param {Array<{id: string, frequencia?: string}>} recorrencias
 * @param {string} ym  competência 'YYYY-MM' (mês em SP)
 * @returns {Promise<Set<string>>} ids das recorrências já pagas ou puladas no mês
 */
async function resolvidasNoMes(recorrencias, ym) {
  const resolvidas = new Set();
  try {
    const ids = (recorrencias || [])
      .filter((r) => r && r.id && (r.frequencia || 'mensal') !== 'semanal')
      .map((r) => r.id);
    if (!ids.length || !ym) return resolvidas;

    const [txV, ajV] = await Promise.all([
      supabase.from('transacoes').select('recorrencia_id')
        .in('recorrencia_id', ids).eq('competencia', ym)
        .then((r) => r, () => ({ data: [] })),
      supabase.from('previsao_ajustes').select('recorrencia_id')
        .in('recorrencia_id', ids).eq('competencia', ym).eq('status', 'pulado')
        .then((r) => r, () => ({ data: [] })),
    ]);
    for (const t of txV.data || []) resolvidas.add(t.recorrencia_id);
    for (const a of ajV.data || []) resolvidas.add(a.recorrencia_id);
  } catch {
    resolvidas.clear();
  }
  return resolvidas;
}

module.exports = { resolvidasNoMes };
