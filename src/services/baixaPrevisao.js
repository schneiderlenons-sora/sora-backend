const supabase = require('../db/supabase');
const { casar, JANELA_DIAS } = require('./casarPrevisao');
const { venceHoje } = require('./frequenciaRecorrencia');

// =============================================================================
// BAIXA DE PREVISÃO — a parte que toca o banco de dados.
//
// A regra de CASAMENTO mora em `casarPrevisao.js`, pura e com eval próprio.
// Aqui fica só o que precisa de I/O: expandir as ocorrências abertas, buscar as
// cobranças candidatas e, quando a pessoa ligou a chave, gravar o vínculo.
//
// ⚠️ ESTE ARQUIVO É USADO POR DOIS CAMINHOS, e é por isso que ele existe:
//
//   · `/api/previstos/ocorrencias` → devolve SUGESTÕES (o padrão);
//   · o sync do Open Finance       → quita sozinho quando `baixa_automatica`.
//
// Se cada um tivesse a sua cópia, a tela poderia sugerir uma coisa e o sync
// quitar outra — e o usuário não teria como saber qual está certa. É o mesmo
// erro que produziu 5 regras de período de fatura nesta base.
// =============================================================================

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * As previsões AINDA ABERTAS na janela — o que o extrato desenharia.
 *
 * ⚠️ QUEM DECIDE SE UMA RECORRÊNCIA VENCE NUM DIA É `venceHoje`, a função
 * canônica do backend (a mesma que o cron usa pra lançar). Reimplementar
 * "cai no dia 10" aqui criaria mais uma cópia de regra de data — e a
 * divergência apareceria como a Sora quitando uma ocorrência que o cron nem
 * considera existir.
 */
async function previsoesAbertas(grupoId, de, ate, quitacoes = [], ajustes = []) {
  const { data: recs } = await supabase.from('recorrencias')
    .select('id, descricao, tipo, valor, dia_vencimento, carteira, valor_variavel, frequencia, dia_semana, mes_vencimento, data_inicio, data_fim, ativo')
    .eq('grupo_id', grupoId);
  if (!recs || !recs.length) return [];

  const jaResolvida = new Set([
    ...quitacoes.map((q) => `${q.recorrenciaId || q.recorrencia_id}:${q.competencia}`),
    ...ajustes.map((a) => `${a.recorrenciaId || a.recorrencia_id}:${a.competencia}`),
  ]);

  const inicio = new Date(`${de}-01T12:00:00`);
  const [ay, am] = ate.split('-').map(Number);
  const fim = new Date(ay, am, 0, 12);

  const out = [];
  for (const r of recs) {
    if (r.ativo === false) continue;
    if (!(Number(r.valor) > 0)) continue;
    const cur = new Date(inicio);
    for (let i = 0; cur <= fim && i < 400; i++, cur.setDate(cur.getDate() + 1)) {
      const dia = iso(cur);
      if (!venceHoje(r, dia)) continue;
      const comp = dia.slice(0, 7);
      if (jaResolvida.has(`${r.id}:${comp}`)) continue;
      out.push({
        recorrencia_id: r.id, competencia: comp, vencimento: dia,
        valor: r.valor, carteira: r.carteira, tipo: r.tipo,
        valor_variavel: !!r.valor_variavel,
      });
    }
  }
  return out;
}

/** Cobranças do banco que casam com previsões abertas. */
async function sugerirBaixas(grupoId, de, ate, quitacoes = [], ajustes = []) {
  if (!grupoId || !de || !ate) return [];
  const previsoes = await previsoesAbertas(grupoId, de, ate, quitacoes, ajustes);
  if (!previsoes.length) return [];

  // Janela alargada pela tolerância: o pagamento pode ter caído fora do mês.
  const menor = previsoes.reduce((m, p) => (p.vencimento < m ? p.vencimento : m), previsoes[0].vencimento);
  const maior = previsoes.reduce((m, p) => (p.vencimento > m ? p.vencimento : m), previsoes[0].vencimento);
  const d0 = new Date(`${menor}T12:00:00`); d0.setDate(d0.getDate() - JANELA_DIAS);
  const d1 = new Date(`${maior}T12:00:00`); d1.setDate(d1.getDate() + JANELA_DIAS);

  const { data: txs } = await supabase.from('transacoes')
    .select('id, data, valor, tipo, carteira_nome, of_tx_id, recorrencia_id')
    .eq('grupo_id', grupoId)
    .not('of_tx_id', 'is', null)
    .is('recorrencia_id', null)
    .gte('data', iso(d0)).lte('data', iso(d1));

  return casar(previsoes, txs || []);
}

/** As ocorrências já resolvidas — pra não sugerir baixa do que já foi baixado. */
async function jaResolvidas(grupoId, de, ate) {
  const [tx, aj] = await Promise.all([
    supabase.from('transacoes').select('recorrencia_id, competencia')
      .eq('grupo_id', grupoId).not('recorrencia_id', 'is', null)
      .gte('competencia', de).lte('competencia', ate)
      .then((r) => r, () => ({ data: [] })),
    supabase.from('previsao_ajustes').select('recorrencia_id, competencia')
      .eq('grupo_id', grupoId).gte('competencia', de).lte('competencia', ate)
      .then((r) => r, () => ({ data: [] })),
  ]);
  return { quitacoes: tx.data || [], ajustes: aj.data || [] };
}

/**
 * BAIXA AUTOMÁTICA — chamada no fim do sync do Open Finance.
 *
 * ⚠️ ELA NÃO CRIA TRANSAÇÃO. A cobrança do banco JÁ É o pagamento; criar outra
 * linha seria exatamente a duplicata que este trabalho inteiro existe pra
 * eliminar. O que ela faz é AMARRAR a transação existente à ocorrência.
 *
 * ⚠️ SÓ AGE COM A CHAVE LIGADA, que nasce `false`. E mesmo ligada, só toca no
 * que `casar()` marcou como `automatico` — ambiguidade e conta de valor
 * variável continuam esperando confirmação humana.
 *
 * ⚠️ TOLERANTE: qualquer falha aqui é engolida. Este é um acréscimo de
 * conveniência no fim do sync; derrubar a sincronização inteira por causa dele
 * seria trocar um problema pequeno por um grande.
 */
async function aplicarBaixaAutomatica(grupoId, userId) {
  try {
    if (!grupoId || !userId) return { aplicadas: 0 };

    const { data: u } = await supabase.from('users')
      .select('baixa_automatica').eq('id', userId).single();
    if (!u || u.baixa_automatica !== true) return { aplicadas: 0, desligada: true };

    const hoje = new Date();
    const de  = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const ateD = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
    const ate = `${ateD.getFullYear()}-${String(ateD.getMonth() + 1).padStart(2, '0')}`;

    const { quitacoes, ajustes } = await jaResolvidas(grupoId, de, ate);
    const casos = await sugerirBaixas(grupoId, de, ate, quitacoes, ajustes);
    const automaticos = casos.filter((c) => c.automatico);
    if (!automaticos.length) return { aplicadas: 0 };

    let aplicadas = 0;
    for (const c of automaticos) {
      // ⚠️ O `is('recorrencia_id', null)` no UPDATE é a trava de corrida: se
      // algo amarrou essa transação entre o cálculo e agora (a pessoa deu baixa
      // pela tela, outro sync rodou), o update não acha linha e não sobrescreve.
      const { error } = await supabase.from('transacoes')
        .update({ recorrencia_id: c.recorrencia_id, competencia: c.competencia })
        .eq('id', c.transacao_id).eq('grupo_id', grupoId)
        .is('recorrencia_id', null);
      if (!error) aplicadas++;
    }
    return { aplicadas };
  } catch {
    return { aplicadas: 0, erro: true };
  }
}

module.exports = { previsoesAbertas, sugerirBaixas, jaResolvidas, aplicarBaixaAutomatica };
