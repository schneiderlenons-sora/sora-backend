const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { gerarDre, sugerirConciliacao } = require('../handlers/negocios');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano').eq('phone', norm(phone)).maybeSingle();
  return data;
}

// Apenas Black tem acesso à aba Negócios
function exigirBlack(user) {
  return user?.plano === 'black';
}

// ─────────────────────────────────────────────────────────────────
// INTEGRAÇÕES — CRUD
// ─────────────────────────────────────────────────────────────────

// GET /api/negocios/integracoes/:phone
router.get('/integracoes/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Disponível apenas no plano Black.' });

    const { data, error } = await supabase
      .from('integracoes')
      .select('id, plataforma, apelido, status, ultimo_sync, total_eventos, created_at, ultimo_erro')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /api/negocios/integracoes — { phone, plataforma, credenciais, apelido? }
router.post('/integracoes', auth, async (req, res) => {
  try {
    const { phone, plataforma, credenciais, apelido } = req.body;
    const user = await getUser(phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });
    if (!['hotmart','kiwify','eduzz','stripe','mercadopago','asaas','pagseguro','shopify','woocommerce'].includes(plataforma))
      return res.status(400).json({ erro: 'Plataforma inválida.' });

    // TODO: criptografar credenciais com chave de servidor (libsodium).
    // Por ora salvamos como jsonb e dependemos da política RLS + service key.
    const { data, error } = await supabase
      .from('integracoes')
      .insert({
        user_id: user.id,
        grupo_id: user.grupo_ativo,
        plataforma,
        apelido: apelido || null,
        credenciais: credenciais || {},
        webhook_secret: gerarSecret(),
        status: 'ativa',
        proximo_sync: new Date(Date.now() + 60_000).toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, integracao: { id: data.id, webhook_secret: data.webhook_secret } });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// DELETE /api/negocios/integracoes/:id
router.delete('/integracoes/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('integracoes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// DRE — resumo por período
// ─────────────────────────────────────────────────────────────────

// GET /api/negocios/dre/:phone?periodo=YYYY-MM
router.get('/dre/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });

    const mesParam = req.query.periodo || new Date().toISOString().slice(0, 7);
    const periodo = `${mesParam}-01`;

    // Tenta usar snapshot cacheado; se não houver, gera
    let { data: snap } = await supabase
      .from('dre_snapshots')
      .select('*')
      .eq('user_id', user.id)
      .eq('periodo', periodo)
      .maybeSingle();

    if (!snap) {
      snap = await gerarDre(user.id, user.grupo_ativo, periodo);
    }

    // Delta vs mês anterior
    const anteriorDate = new Date(periodo);
    anteriorDate.setMonth(anteriorDate.getMonth() - 1);
    const anterior = anteriorDate.toISOString().slice(0, 10);
    const { data: prev } = await supabase
      .from('dre_snapshots').select('lucro_liquido').eq('user_id', user.id).eq('periodo', anterior).maybeSingle();
    const delta_vs_anterior = prev?.lucro_liquido
      ? ((snap.lucro_liquido - prev.lucro_liquido) / Math.abs(prev.lucro_liquido)) * 100
      : 0;

    // Sparkline — receita dos últimos 30 dias
    const trintaAtras = new Date();
    trintaAtras.setDate(trintaAtras.getDate() - 30);
    const { data: spark } = await supabase
      .from('eventos_financeiros')
      .select('data_evento, valor_liquido, tipo')
      .eq('user_id', user.id)
      .gte('data_evento', trintaAtras.toISOString());

    const dias = Array.from({ length: 30 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (29 - i));
      const key = d.toISOString().slice(0, 10);
      const total = (spark || [])
        .filter(e => e.data_evento.slice(0, 10) === key && (e.tipo === 'venda' || e.tipo === 'assinatura_renovacao'))
        .reduce((s, e) => s + e.valor_liquido, 0);
      return Math.round(total / 100);
    });

    res.json({
      ...snap,
      delta_vs_anterior: Number(delta_vs_anterior.toFixed(2)),
      spark: dias,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /api/negocios/dre/recalcular — { phone, periodo: 'YYYY-MM' }
router.post('/dre/recalcular', auth, async (req, res) => {
  try {
    const { phone, periodo } = req.body;
    const user = await getUser(phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const mes = (periodo || new Date().toISOString().slice(0, 7)) + '-01';
    await supabase.from('dre_snapshots').delete().eq('user_id', user.id).eq('periodo', mes);
    const snap = await gerarDre(user.id, user.grupo_ativo, mes);
    res.json(snap);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// EVENTOS — lista crua de vendas/refunds
// ─────────────────────────────────────────────────────────────────

// GET /api/negocios/eventos/:phone?limit=50&offset=0&tipo=venda
router.get('/eventos/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const limit  = Math.min(parseInt(req.query.limit || '50'), 200);
    const offset = parseInt(req.query.offset || '0');
    let q = supabase.from('eventos_financeiros')
      .select('*', { count: 'exact' })
      .eq('user_id', user.id)
      .order('data_evento', { ascending: false })
      .range(offset, offset + limit - 1);
    if (req.query.tipo)       q = q.eq('tipo', req.query.tipo);
    if (req.query.plataforma) q = q.eq('plataforma', req.query.plataforma);
    if (req.query.periodo) {
      const inicio = req.query.periodo + '-01';
      const fim    = new Date(inicio); fim.setMonth(fim.getMonth() + 1);
      q = q.gte('data_evento', inicio).lt('data_evento', fim.toISOString().slice(0, 10));
    }
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ eventos: data || [], total: count || 0 });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// CUSTOS — CRUD
// ─────────────────────────────────────────────────────────────────

router.get('/custos/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const mes = req.query.periodo || new Date().toISOString().slice(0, 7);
    const inicio = mes + '-01';
    const fim = new Date(inicio); fim.setMonth(fim.getMonth() + 1);
    const { data, error } = await supabase
      .from('custos_negocio')
      .select('*')
      .eq('user_id', user.id)
      .gte('data', inicio).lt('data', fim.toISOString().slice(0, 10))
      .order('data', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/custos', auth, async (req, res) => {
  try {
    const { phone, categoria, descricao, valor, data, fornecedor, recorrente, recorrencia, observacao } = req.body;
    const user = await getUser(phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const valorCentavos = typeof valor === 'number' && valor > 10000 ? valor : Math.round((parseFloat(valor) || 0) * 100);
    const { data: row, error } = await supabase.from('custos_negocio').insert({
      user_id: user.id,
      grupo_id: user.grupo_ativo,
      categoria,
      descricao,
      valor: valorCentavos,
      data: data || new Date().toISOString().slice(0, 10),
      fornecedor: fornecedor || null,
      recorrente: !!recorrente,
      recorrencia: recorrencia || null,
      observacao: observacao || null,
    }).select().single();
    if (error) throw error;

    // Invalida snapshot do mês
    const mes = row.data.slice(0, 7) + '-01';
    await supabase.from('dre_snapshots').delete().eq('user_id', user.id).eq('periodo', mes);

    res.json({ ok: true, custo: row });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.delete('/custos/:id', auth, async (req, res) => {
  try {
    const { data: row } = await supabase.from('custos_negocio').select('user_id, data').eq('id', req.params.id).maybeSingle();
    const { error } = await supabase.from('custos_negocio').delete().eq('id', req.params.id);
    if (error) throw error;
    if (row) {
      const mes = row.data.slice(0, 7) + '-01';
      await supabase.from('dre_snapshots').delete().eq('user_id', row.user_id).eq('periodo', mes);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// CONFIG — regime tributário, alíquotas
// ─────────────────────────────────────────────────────────────────

router.get('/config/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const { data } = await supabase.from('config_negocio').select('*').eq('user_id', user.id).maybeSingle();
    res.json(data || {
      user_id: user.id,
      grupo_id: user.grupo_ativo,
      regime_tributario: 'mei',
      aliquota_simples: 6.0,
      reservar_imposto: true,
      pct_reserva_imposto: 6.0,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.put('/config', auth, async (req, res) => {
  try {
    const { phone, ...payload } = req.body;
    const user = await getUser(phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const upd = {
      user_id: user.id,
      grupo_id: user.grupo_ativo,
      ...payload,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('config_negocio').upsert(upd, { onConflict: 'user_id' }).select().single();
    if (error) throw error;

    // Invalida snapshot do mês corrente (mudança de alíquota muda DRE)
    const mes = new Date().toISOString().slice(0, 7) + '-01';
    await supabase.from('dre_snapshots').delete().eq('user_id', user.id).eq('periodo', mes);

    res.json(data);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// INSIGHTS / ALERTAS
// ─────────────────────────────────────────────────────────────────

router.get('/insights/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const { data, error } = await supabase
      .from('insights_negocio')
      .select('*')
      .eq('user_id', user.id)
      .eq('dispensado', false)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/insights/:id/visto', auth, async (req, res) => {
  try {
    await supabase.from('insights_negocio').update({ visto: true }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/insights/:id/dispensar', auth, async (req, res) => {
  try {
    await supabase.from('insights_negocio').update({ dispensado: true }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// CONCILIAÇÃO
// ─────────────────────────────────────────────────────────────────

router.get('/conciliacao/sugerir/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const sugestoes = await sugerirConciliacao(user.id, user.grupo_ativo);
    res.json(sugestoes);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/conciliacao', auth, async (req, res) => {
  try {
    const { phone, evento_id, transacao_id, match_tipo } = req.body;
    const user = await getUser(phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    await supabase.from('conciliacao_negocio').insert({
      user_id: user.id, evento_id, transacao_id, match_tipo: match_tipo || 'manual',
    });
    await supabase.from('eventos_financeiros')
      .update({ conciliado: true, transacao_id })
      .eq('id', evento_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────────────────────────

function gerarSecret() {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

module.exports = router;
