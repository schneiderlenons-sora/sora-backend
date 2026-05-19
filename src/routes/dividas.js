const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, lembretes_dividas').eq('phone', norm(phone)).maybeSingle();
  return data;
}

// ─────────────────────────────────────────────────────────────────
// GET /api/dividas/:phone — lista dívidas + resumo
// ─────────────────────────────────────────────────────────────────
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const { data: dividas, error } = await supabase.from('dividas')
      .select('*')
      .eq('grupo_id', user.grupo_ativo)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Resumo agregado
    const ativas = (dividas || []).filter(d => d.status === 'ativa' || d.status === 'em_atraso');
    const total_devido = ativas.reduce((s, d) => {
      const restantes = Math.max(0, (d.parcelas_total || 0) - (d.parcelas_pagas || 0));
      const saldo = restantes * (d.valor_parcela || 0);
      return s + (saldo || d.valor_total || 0);
    }, 0);

    const total_quitado = (dividas || []).filter(d => d.status === 'quitada').length;

    // Próximo vencimento — menor dia_vencimento >= hoje, ou mês que vem
    const hoje = new Date();
    const diaHoje = hoje.getDate();
    let proxima = null;
    ativas.forEach(d => {
      if (!d.dia_vencimento) return;
      const venc = new Date(hoje.getFullYear(), hoje.getMonth(), d.dia_vencimento);
      if (d.dia_vencimento < diaHoje) venc.setMonth(venc.getMonth() + 1);
      const dias = Math.ceil((venc.getTime() - hoje.getTime()) / 86400000);
      if (!proxima || dias < proxima.dias) {
        proxima = { divida_id: d.id, titulo: d.titulo, valor: d.valor_parcela, data: venc.toISOString().slice(0, 10), dias };
      }
    });

    // Parcelas do mês
    const parcelas_mes_valor = ativas.reduce((s, d) => s + (d.valor_parcela || 0), 0);

    res.json({
      dividas: dividas || [],
      resumo: {
        total_devido,
        total_ativas: ativas.length,
        total_quitadas: total_quitado,
        parcelas_mes_valor,
        parcelas_mes_count: ativas.filter(d => d.dia_vencimento).length,
        proxima_parcela: proxima,
        lembretes_dividas: user.lembretes_dividas !== false,
      },
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/dividas — cria nova dívida
// ─────────────────────────────────────────────────────────────────
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const {
      titulo, credor, tipo, valor_total, valor_parcela,
      parcelas_total, parcelas_pagas, taxa_juros, indexador,
      dia_vencimento, data_inicio, observacao,
    } = req.body;

    if (!titulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório.' });
    if (!valor_total || valor_total <= 0) return res.status(400).json({ erro: 'Valor total inválido.' });

    // Auto-calcula valor da parcela se não vier mas tem parcelas_total
    let vp = valor_parcela;
    if (!vp && parcelas_total > 0) vp = parseFloat(valor_total) / parseInt(parcelas_total, 10);

    const { data, error } = await supabase.from('dividas').insert({
      grupo_id:       req.grupoId,
      criado_por:     req.userId,
      titulo:         titulo.trim(),
      credor:         credor?.trim() || null,
      tipo:           tipo || 'emprestimo',
      valor_total:    parseFloat(valor_total),
      valor_parcela:  vp ? parseFloat(vp) : null,
      parcelas_total: parcelas_total ? parseInt(parcelas_total, 10) : null,
      parcelas_pagas: parcelas_pagas ? parseInt(parcelas_pagas, 10) : 0,
      taxa_juros:     taxa_juros ? parseFloat(taxa_juros) : null,
      indexador:      indexador || null,
      dia_vencimento: dia_vencimento ? parseInt(dia_vencimento, 10) : null,
      data_inicio:    data_inicio || null,
      observacao:     observacao?.trim() || null,
      status:         (parcelas_total && parseInt(parcelas_pagas || 0, 10) >= parseInt(parcelas_total, 10)) ? 'quitada' : 'ativa',
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// PUT /api/dividas/:id — edita
// ─────────────────────────────────────────────────────────────────
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const allowed = ['titulo','credor','tipo','valor_total','valor_parcela','parcelas_total','parcelas_pagas',
                     'taxa_juros','indexador','dia_vencimento','data_inicio','status','observacao','lembretes_ativos'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('dividas')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /api/dividas/:id
// ─────────────────────────────────────────────────────────────────
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { error } = await supabase.from('dividas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/dividas/:id/pagar — registra pagamento de parcela
// ─────────────────────────────────────────────────────────────────
router.post('/:id/pagar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, tipo, data_pagamento, observacao, numero_parcela } = req.body;
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Valor inválido.' });

    const { data: divida } = await supabase.from('dividas')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (!divida) return res.status(404).json({ erro: 'Dívida não encontrada.' });

    // Insere pagamento
    await supabase.from('divida_pagamentos').insert({
      divida_id:      req.params.id,
      user_id:        req.userId,
      numero_parcela: numero_parcela || (divida.parcelas_pagas + 1),
      valor:          v,
      tipo:           tipo || 'parcela',
      data_pagamento: data_pagamento || new Date().toISOString().slice(0, 10),
      observacao:     observacao || null,
    });

    // Atualiza contadores
    const novasPagas = (divida.parcelas_pagas || 0) + (tipo === 'antecipacao' ? 1 : (tipo === 'juros_atraso' ? 0 : 1));
    const totalParcelas = divida.parcelas_total || 0;
    const novoStatus = totalParcelas > 0 && novasPagas >= totalParcelas ? 'quitada' : divida.status;
    const dataQuitacao = novoStatus === 'quitada' ? new Date().toISOString().slice(0, 10) : null;

    const { data: atualizada } = await supabase.from('dividas').update({
      parcelas_pagas: novasPagas,
      status:         novoStatus,
      data_quitacao:  dataQuitacao,
      updated_at:     new Date().toISOString(),
    }).eq('id', req.params.id).select().single();

    res.json({ divida: atualizada, quitada: novoStatus === 'quitada' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/dividas/:id/quitar — quita a dívida inteira de uma vez
// ─────────────────────────────────────────────────────────────────
router.post('/:id/quitar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, observacao, data_pagamento } = req.body;

    const { data: divida } = await supabase.from('dividas')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (!divida) return res.status(404).json({ erro: 'Dívida não encontrada.' });

    const restantes = Math.max(0, (divida.parcelas_total || 0) - (divida.parcelas_pagas || 0));
    const valorQuitacao = parseFloat(valor) || (restantes * (divida.valor_parcela || 0));

    await supabase.from('divida_pagamentos').insert({
      divida_id:      req.params.id,
      user_id:        req.userId,
      numero_parcela: null,
      valor:          valorQuitacao,
      tipo:           'quitacao',
      data_pagamento: data_pagamento || new Date().toISOString().slice(0, 10),
      observacao:     observacao || 'Quitação antecipada',
    });

    const { data: atualizada } = await supabase.from('dividas').update({
      parcelas_pagas: divida.parcelas_total || divida.parcelas_pagas,
      status:         'quitada',
      data_quitacao:  data_pagamento || new Date().toISOString().slice(0, 10),
      updated_at:     new Date().toISOString(),
    }).eq('id', req.params.id).select().single();

    res.json({ divida: atualizada, quitada: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// PATCH /api/dividas/:id/lembrete — liga/desliga lembrete de UMA dívida
// ─────────────────────────────────────────────────────────────────
router.patch('/:id/lembrete', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { ativo } = req.body;
    const { data, error } = await supabase.from('dividas')
      .update({ lembretes_ativos: !!ativo, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// PATCH /api/dividas/lembretes/:phone — liga/desliga TODOS lembretes do usuário
// ─────────────────────────────────────────────────────────────────
router.patch('/lembretes/:phone', auth, async (req, res) => {
  try {
    const { ativo } = req.body;
    const { data, error } = await supabase.from('users')
      .update({ lembretes_dividas: !!ativo })
      .eq('phone', norm(req.params.phone)).select('phone, lembretes_dividas').single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/dividas/:id/pagamentos — histórico de uma dívida
// ─────────────────────────────────────────────────────────────────
router.get('/:id/pagamentos', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('divida_pagamentos')
      .select('*').eq('divida_id', req.params.id)
      .order('data_pagamento', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
