const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta } = require('../services/contaDebito');
const { proximoVencimento, ultimoPagamentoPorDivida, hojeSP, emAtraso } = require('../services/vencimentoDivida');

const norm = p => p?.replace(/\D/g, '');

async function getUser(req) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, lembretes_dividas').eq('id', req.authUser?.id || '__none__').maybeSingle();
  return data;
}

// ─────────────────────────────────────────────────────────────────
// GET /api/dividas/:phone — lista dívidas + resumo
// ─────────────────────────────────────────────────────────────────
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const { data: dividas, error } = await supabase.from('dividas')
      .select('*')
      .eq('grupo_id', user.grupo_ativo)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Data do último pagamento por dívida — é o que impede o painel de avisar
    // de uma parcela que o usuário ACABOU de pagar (ver vencimentoDivida.js).
    // Vai junto na resposta pro card do painel usar a mesma regra.
    const ultimoPg = await ultimoPagamentoPorDivida((dividas || []).map(d => d.id));
    for (const d of dividas || []) d.ultimo_pagamento = ultimoPg[d.id] || null;

    // Resumo agregado
    const ativas = (dividas || []).filter(d => d.status === 'ativa' || d.status === 'em_atraso');
    // Saldo do BANCO primeiro (migration 155): é o valor de quitação hoje. A
    // conta local só entra quando ele não existe — dívida manual —, porque
    // ela soma juros futuros e depende de `parcelas_pagas`, que vem furada
    // do emissor.
    const total_devido = ativas.reduce((s, d) => {
      if (d.saldo_devedor != null) return s + Number(d.saldo_devedor);
      const restantes = Math.max(0, (d.parcelas_total || 0) - (d.parcelas_pagas || 0));
      const saldo = restantes * (d.valor_parcela || 0);
      return s + (saldo || d.valor_total || 0);
    }, 0);

    const total_quitado = (dividas || []).filter(d => d.status === 'quitada').length;

    // Próximo vencimento — a dívida que vence primeiro, JÁ descontando as
    // parcelas pagas neste ciclo (regra única em services/vencimentoDivida.js).
    const hojeStr = hojeSP();
    let proxima = null;
    ativas.forEach(d => {
      const v = proximoVencimento(d, hojeStr);
      if (!v) return;
      if (!proxima || v.dias < proxima.dias) {
        proxima = { divida_id: d.id, titulo: d.titulo, valor: d.valor_parcela, data: v.data, dias: v.dias };
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
/**
 * Campos exclusivos do CONSÓRCIO (migration 125), só os que vieram no body.
 *
 * O que faz o consórcio ser diferente de um financiamento: existe uma CARTA DE
 * CRÉDITO (dinheiro a receber, não só a pagar) e uma CONTEMPLAÇÃO que divide a
 * vida da cota em antes e depois. Nenhum outro tipo de dívida tem isso.
 *
 * ⚠️ A taxa de administração NÃO tem campo próprio: `taxa_juros` já guarda uma
 * taxa em % e ter duas colunas pro mesmo número daria divergência. O que muda
 * é o RÓTULO na tela.
 */
function camposConsorcio(body = {}) {
  const num = (v) => (v === '' || v == null ? null : parseFloat(v));
  const txt = (v) => (String(v ?? '').trim() || null);
  const out = {};
  if (body.consorcio_credito      !== undefined) out.consorcio_credito      = num(body.consorcio_credito);
  if (body.consorcio_lance        !== undefined) out.consorcio_lance        = num(body.consorcio_lance);
  if (body.consorcio_grupo        !== undefined) out.consorcio_grupo        = txt(body.consorcio_grupo);
  if (body.consorcio_cota         !== undefined) out.consorcio_cota         = txt(body.consorcio_cota);
  if (body.consorcio_contemplado  !== undefined) out.consorcio_contemplado  = !!body.consorcio_contemplado;
  if (body.consorcio_contemplado_em !== undefined) out.consorcio_contemplado_em = body.consorcio_contemplado_em || null;
  return out;
}

/** A coluna do consórcio ainda não existe? (migration 125 pendente) */
const faltaMigrationConsorcio = (erro) => /consorcio_/i.test(erro?.message || '');

router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const {
      titulo, credor, tipo, valor_total, valor_parcela,
      parcelas_total, parcelas_pagas, taxa_juros, indexador,
      dia_vencimento, data_inicio, observacao, imagem_url,
    } = req.body;

    // Campos só do CONSÓRCIO (migration 125). Ficam num objeto à parte porque
    // são removidos em bloco se a migration ainda não rodou — a dívida é criada
    // sem eles em vez de falhar (mesma tolerância do `imagem_url`).
    const extrasConsorcio = camposConsorcio(req.body);

    if (!titulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório.' });
    if (!valor_total || valor_total <= 0) return res.status(400).json({ erro: 'Valor total inválido.' });

    // Auto-calcula valor da parcela se não vier mas tem parcelas_total
    let vp = valor_parcela;
    if (!vp && parcelas_total > 0) vp = parseFloat(valor_total) / parseInt(parcelas_total, 10);

    const payload = {
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
    };
    if (imagem_url) payload.imagem_url = imagem_url;
    Object.assign(payload, extrasConsorcio);

    // `imagem_url` é coluna nova (migration 088). Se ainda não rodou, remove e
    // tenta de novo (a dívida cria sem foto até migrar).
    let r = await supabase.from('dividas').insert(payload).select().single();
    if (r.error && 'imagem_url' in payload && /imagem_url|column/i.test(r.error.message || '')) {
      delete payload.imagem_url;
      r = await supabase.from('dividas').insert(payload).select().single();
    }
    // Idem pros campos do consórcio (migration 125): sem eles a dívida ainda é
    // criada — perder a carta inteira por causa de um campo extra seria pior.
    if (r.error && faltaMigrationConsorcio(r.error)) {
      for (const k of Object.keys(extrasConsorcio)) delete payload[k];
      r = await supabase.from('dividas').insert(payload).select().single();
    }
    // Fallback: CHECK ainda sem 'parcelamento' (migration 097 não rodou) → 'outro'.
    if (r.error && /dividas_tipo_check/i.test(r.error.message || '')) {
      r = await supabase.from('dividas').insert({ ...payload, tipo: 'outro' }).select().single();
    }
    if (r.error) throw r.error;
    res.json(r.data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// PUT /api/dividas/:id — edita
// ─────────────────────────────────────────────────────────────────
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    // `nos_previstos` (migration 115): mostra/soma a parcela no card "Previstos
    // do mês". Tolerante — sem a 115 o update com essa chave falha e o handler
    // devolve o erro; por isso ela só chega aqui quando o painel manda.
    const allowed = ['titulo','credor','tipo','valor_total','valor_parcela','parcelas_total','parcelas_pagas',
                     'taxa_juros','indexador','dia_vencimento','data_inicio','status','observacao','lembretes_ativos','imagem_url',
                     'nos_previstos'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    // Campos do consórcio (migration 125) — ver `camposConsorcio`.
    const extrasConsorcio = camposConsorcio(req.body);
    Object.assign(patch, extrasConsorcio);
    patch.updated_at = new Date().toISOString();

    const upd = () => supabase.from('dividas').update(patch).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    let r = await upd();
    if (r.error && 'imagem_url' in patch && /imagem_url|column/i.test(r.error.message || '')) {
      delete patch.imagem_url; // migration 088 pendente
      r = await upd();
    }
    if (r.error && faltaMigrationConsorcio(r.error)) {
      // Migration 125 pendente: salva o resto em vez de perder a edição toda.
      for (const k of Object.keys(extrasConsorcio)) delete patch[k];
      r = Object.keys(patch).length > 1 ? await upd() : r;
    }
    if (r.error) throw r.error;
    res.json(r.data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /api/dividas/:id
// ─────────────────────────────────────────────────────────────────
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { error } = await supabase.from('dividas').delete().eq('id', req.params.id).eq('grupo_id', req.grupoId);
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

    // ⚠️ 'em_atraso' ERA UMA FLAG DE MÃO ÚNICA. O cron a escrevia (jobs/index.js)
    // e NADA nunca a apagava: aqui o status simplesmente se preservava
    // (`: divida.status`), então uma dívida marcada em atraso continuava
    // "EM ATRASO" pra sempre depois de paga — até ser quitada por inteiro.
    // O card, logo abaixo do badge, já dizia "Parcela paga · próxima em Nd",
    // porque a LINHA usa `proximoVencimento` e o BADGE lia a coluna crua. Duas
    // regras pro mesmo fato, se contradizendo no mesmo cartão.
    //
    // Agora o badge passa a sair da MESMA fonte canônica que a linha:
    // `quitadaNoCiclo` = o pagamento cobriu a parcela do ciclo corrente.
    let novoStatus = divida.status;
    if (totalParcelas > 0 && novasPagas >= totalParcelas) {
      novoStatus = 'quitada';
    } else if (divida.status === 'em_atraso') {
      try {
        // Relê o último pagamento em vez de confiar no que veio no corpo: o
        // helper já exclui `juros_atraso` (pagar juros não anda parcela, logo
        // não pode tirar ninguém do atraso) e pega o MAIOR, não o mais recente
        // inserido — registrar um pagamento antigo não pode "despiorar" nada.
        const mapa = await ultimoPagamentoPorDivida([req.params.id]);
        const alvo = { ...divida, parcelas_pagas: novasPagas, ultimo_pagamento: mapa[req.params.id] };
        if (!emAtraso(alvo)) novoStatus = 'ativa';
      } catch (e) {
        // Falhar aqui não pode derrubar o registro do pagamento — no pior caso
        // o badge continua como estava.
        console.warn('[dividas/pagar] status:', e.message);
      }
    }
    const dataQuitacao = novoStatus === 'quitada' ? new Date().toISOString().slice(0, 10) : null;

    const { data: atualizada } = await supabase.from('dividas').update({
      parcelas_pagas: novasPagas,
      status:         novoStatus,
      data_quitacao:  dataQuitacao,
      updated_at:     new Date().toISOString(),
    }).eq('id', req.params.id).select().single();

    // Opcional: desconta de uma conta e registra a saída nas transações.
    let debito = null;
    if (req.body.wallet_id) {
      try {
        debito = await debitarConta({
          grupoId: req.grupoId, walletId: req.body.wallet_id, valor: v,
          categoria: 'Dívidas', observacao: `Pagamento: ${divida.titulo}`,
          userId: req.userId, data: data_pagamento,
        });
      } catch (e) { debito = { erro: e.message }; }
    }

    res.json({ divida: atualizada, quitada: novoStatus === 'quitada', debito });
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

    // Opcional: desconta de uma conta e registra a saída nas transações.
    let debito = null;
    if (req.body.wallet_id) {
      try {
        debito = await debitarConta({
          grupoId: req.grupoId, walletId: req.body.wallet_id, valor: valorQuitacao,
          categoria: 'Dívidas', observacao: `Quitação: ${divida.titulo}`,
          userId: req.userId, data: data_pagamento,
        });
      } catch (e) { debito = { erro: e.message }; }
    }

    res.json({ divida: atualizada, quitada: true, debito });
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
      .eq('id', req.authUser?.id || '__none__').select('phone, lembretes_dividas').single();
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
