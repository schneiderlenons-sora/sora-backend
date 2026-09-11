const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

// =============================================================================
// PREVISTOS — quitar, pular e adiar UMA ocorrência.
//
// Estas rotas existem por causa de um relato de cliente:
//
//   "Tenho um gasto fixo de ~R$ 1.700 com plano de saúde. Se eu antecipo o
//    pagamento, não consigo dar baixa naquele valor previsto do mês. Se
//    registro o pagamento como nova transação, passo a ter valores duplicados."
//
// Faltava a OCORRÊNCIA: a instância datada de um compromisso, que pode ser
// adiantada, atrasada, ter valor diferente, ser pulada ou quitada — sem mexer
// na regra. Migration 165 criou o elo (`transacoes.recorrencia_id` +
// `competencia`, e a tabela `previsao_ajustes`).
//
// ⚠️ A CHAVE É A COMPETÊNCIA, NÃO A DATA. É o que faz "paguei dia 8 a conta
// que vence dia 10" cancelar a previsão de SETEMBRO: a data difere, a
// competência não. Mesma ideia do `competenciaDoPagamento` que resolveu o
// pagamento de fatura do cartão.
// =============================================================================

async function contexto(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return { grupoId: data?.grupo_ativo || null, userId: req.authUser?.id || null };
}

const COMPETENCIA = /^\d{4}-\d{2}$/;
const DIA         = /^\d{4}-\d{2}-\d{2}$/;

// ⚠️ As funcoes que tocam o banco moram em `services/baixaPrevisao.js` — as
// MESMAS que o sync do Open Finance usa pra baixa automatica. Duas copias
// fariam a tela sugerir uma coisa e o sync quitar outra.
const { sugerirBaixas } = require('../services/baixaPrevisao');

/**
 * GET /api/previstos/ocorrencias/:phone?de=YYYY-MM&ate=YYYY-MM
 *
 * O que a tela precisa saber para NÃO desenhar uma previsão que já foi
 * resolvida: quais ocorrências já têm transação (quitadas) e quais têm ajuste
 * (puladas/adiadas).
 *
 * ⚠️ Devolve só o VÍNCULO, não a transação inteira — a tela já busca as
 * transações pelo caminho normal, e mandá-las de novo aqui seria pagar o mesmo
 * payload duas vezes (foi assim que o `avatar_url` estourou a cota do Supabase).
 */
router.get('/ocorrencias/:phone', auth, async (req, res) => {
  try {
    const { grupoId } = await contexto(req);
    if (!grupoId) return res.json({ quitacoes: [], ajustes: [] });

    const de  = COMPETENCIA.test(req.query.de  || '') ? req.query.de  : null;
    const ate = COMPETENCIA.test(req.query.ate || '') ? req.query.ate : null;

    let q = supabase.from('transacoes')
      .select('id, recorrencia_id, competencia, data, valor')
      .eq('grupo_id', grupoId)
      .not('recorrencia_id', 'is', null);
    if (de)  q = q.gte('competencia', de);
    if (ate) q = q.lte('competencia', ate);

    let a = supabase.from('previsao_ajustes')
      .select('recorrencia_id, competencia, status, nova_data, novo_valor')
      .eq('grupo_id', grupoId);
    if (de)  a = a.gte('competencia', de);
    if (ate) a = a.lte('competencia', ate);

    // ⚠️ Em paralelo, e CADA UMA com o seu catch: uma rejeição derruba a outra
    // no Promise.all, e a de ajustes pode falhar de propósito enquanto a
    // migration 165 não tiver rodado (leitura tolerante).
    const [tx, aj] = await Promise.all([
      q.then((r) => r).catch(() => ({ data: [] })),
      a.then((r) => r).catch(() => ({ data: [] })),
    ]);

    const quitacoes = (tx.data || []).map((t) => ({
      recorrenciaId: t.recorrencia_id, competencia: t.competencia,
      transacaoId: t.id, data: t.data, valor: t.valor,
    }));
    const ajustes = (aj.data || []).map((x) => ({
      recorrenciaId: x.recorrencia_id, competencia: x.competencia,
      status: x.status, novaData: x.nova_data, novoValor: x.novo_valor,
    }));

    // ⚠️ SUGESTÕES SÃO TOLERANTES: se falharem, a tela continua funcionando
    // sem elas. Elas são um atalho, nunca um pré-requisito — quem não tem Open
    // Finance (ou tem e deu erro) dá baixa manualmente, que é o caminho
    // principal e completo.
    let sugestoes = [];
    try {
      sugestoes = await sugerirBaixas(grupoId, de, ate, quitacoes, ajustes);
    } catch { /* segue sem sugestão */ }

    res.json({ quitacoes, ajustes, sugestoes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/**
 * POST /api/previstos/quitar — "paguei esta conta".
 *
 * Cria a transação REAL já amarrada à ocorrência. É o vínculo que impede a
 * duplicata: com ele, o extrato para de gerar a previsão daquela competência.
 */
router.post('/quitar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { grupoId, userId } = await contexto(req);
    if (!grupoId) return res.status(400).json({ erro: 'sem grupo ativo' });

    const { recorrencia_id, competencia, data, valor, carteira_nome } = req.body || {};
    if (!recorrencia_id || !COMPETENCIA.test(competencia || '')) {
      return res.status(400).json({ erro: 'recorrencia_id e competencia (YYYY-MM) sao obrigatorios' });
    }
    if (data && !DIA.test(data)) return res.status(400).json({ erro: 'data invalida' });

    const { data: rec } = await supabase.from('recorrencias')
      .select('*').eq('id', recorrencia_id).eq('grupo_id', grupoId).single();
    if (!rec) return res.status(404).json({ erro: 'conta fixa nao encontrada' });

    // ⚠️ IDEMPOTENTE. Dois toques no botão (ou o retry de uma rede ruim) não
    // podem gerar dois pagamentos — seria exatamente a duplicata que esta rota
    // existe pra eliminar.
    const { data: jaTem } = await supabase.from('transacoes')
      .select('id').eq('grupo_id', grupoId)
      .eq('recorrencia_id', recorrencia_id).eq('competencia', competencia)
      .limit(1);
    if (jaTem && jaTem.length) {
      return res.json({ ok: true, id: jaTem[0].id, jaQuitada: true });
    }

    const valorFinal = Number(valor) > 0 ? Number(valor) : Number(rec.valor);
    const linha = {
      grupo_id:       grupoId,
      criado_por:     userId,
      tipo:           rec.tipo,
      valor:          valorFinal,
      categoria:      rec.categoria || null,
      observacao:     rec.descricao || 'Conta fixa',
      carteira_nome:  carteira_nome || rec.carteira || null,
      data:           data || new Date().toISOString().slice(0, 10),
      pago:           true,
      recorrencia_id,
      competencia,
    };

    const { data: nova, error } = await supabase.from('transacoes').insert(linha).select('id').single();
    // ⚠️ LER O `error`. Rota que faz insert sem conferir responde 200 com null
    // e a tela fecha o modal achando que salvou — foi exatamente o bug das
    // migrations 121 e 147.
    if (error) return res.status(500).json({ erro: error.message });

    // Um ajuste (pular/adiar) daquela competência perde o sentido depois de
    // quitada; deixá-lo lá faria a previsão reaparecer deslocada se a
    // transação fosse apagada.
    await supabase.from('previsao_ajustes')
      .delete().eq('recorrencia_id', recorrencia_id).eq('competencia', competencia)
      .then(() => {}, () => {});

    res.json({ ok: true, id: nova?.id });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/**
 * POST /api/previstos/ajuste — pular ou adiar UMA ocorrência.
 *
 * ⚠️ NÃO cria transação. Pular ("este mês não pago") e adiar ("caiu pro dia
 * 20") são desvios da PREVISÃO; gravá-los como transação de valor zero sujaria
 * o extrato, o resumo do mês e os relatórios.
 */
router.post('/ajuste', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { grupoId } = await contexto(req);
    if (!grupoId) return res.status(400).json({ erro: 'sem grupo ativo' });

    const { recorrencia_id, competencia, status, nova_data, novo_valor } = req.body || {};
    if (!recorrencia_id || !COMPETENCIA.test(competencia || '')) {
      return res.status(400).json({ erro: 'recorrencia_id e competencia (YYYY-MM) sao obrigatorios' });
    }
    if (!['pulado', 'movido'].includes(status)) {
      return res.status(400).json({ erro: 'status deve ser pulado ou movido' });
    }
    if (status === 'movido' && !DIA.test(nova_data || '')) {
      return res.status(400).json({ erro: 'adiar exige nova_data (YYYY-MM-DD)' });
    }

    const { data: rec } = await supabase.from('recorrencias')
      .select('id').eq('id', recorrencia_id).eq('grupo_id', grupoId).single();
    if (!rec) return res.status(404).json({ erro: 'conta fixa nao encontrada' });

    const { error } = await supabase.from('previsao_ajustes').upsert({
      grupo_id: grupoId,
      recorrencia_id,
      competencia,
      status,
      nova_data:  status === 'movido' ? nova_data : null,
      novo_valor: novo_valor != null ? Number(novo_valor) : null,
    }, { onConflict: 'recorrencia_id,competencia' });
    if (error) return res.status(500).json({ erro: error.message });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/**
 * DELETE /api/previstos/ajuste — desfaz o pular/adiar.
 */
router.delete('/ajuste', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { grupoId } = await contexto(req);
    const { recorrencia_id, competencia } = req.body || {};
    if (!grupoId || !recorrencia_id || !COMPETENCIA.test(competencia || '')) {
      return res.status(400).json({ erro: 'parametros invalidos' });
    }
    await supabase.from('previsao_ajustes').delete()
      .eq('grupo_id', grupoId).eq('recorrencia_id', recorrencia_id).eq('competencia', competencia);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/**
 * POST /api/previstos/desfazer-quitacao — "não era essa".
 *
 * ⚠️ NÃO apaga a transação: o dinheiro pode ter saído de verdade. Só CORTA o
 * vínculo, e a previsão daquela competência volta a aparecer. Quem quiser
 * apagar a transação faz isso pela aba Transações, conscientemente.
 */
router.post('/desfazer-quitacao', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { grupoId } = await contexto(req);
    const { transacao_id } = req.body || {};
    if (!grupoId || !transacao_id) return res.status(400).json({ erro: 'transacao_id obrigatorio' });
    const { error } = await supabase.from('transacoes')
      .update({ recorrencia_id: null, competencia: null })
      .eq('id', transacao_id).eq('grupo_id', grupoId);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/**
 * GET/POST /api/previstos/config — a chave GLOBAL da baixa automatica.
 *
 * ⚠️ NASCE DESLIGADA. Ligada, a Sora amarra sozinha a cobranca do banco a
 * previsao; desligada (padrao), ela apenas SUGERE e a pessoa confirma.
 *
 * ⚠️ Mesmo ligada, ambiguidade e conta de valor variavel continuam pedindo
 * confirmacao — ver as travas em services/casarPrevisao.js. A chave governa
 * so o caso sem sombra de duvida.
 */
router.get('/config/:phone', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('users')
      .select('baixa_automatica').eq('id', req.authUser?.id || '__none__').single();
    res.json({ baixa_automatica: data?.baixa_automatica === true });
  } catch { res.json({ baixa_automatica: false }); }
});

router.post('/config', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const ligado = req.body?.baixa_automatica === true;
    const { error } = await supabase.from('users')
      .update({ baixa_automatica: ligado }).eq('id', req.authUser?.id || '__none__');
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ ok: true, baixa_automatica: ligado });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
