const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { gerarDre, sugerirConciliacao } = require('../handlers/negocios');
const { encrypt, decrypt } = require('../services/cripto');
const { importarHistoricoHotmart } = require('../services/hotmart-import');
const { gerarInsights } = require('./../handlers/insights-negocio');

const norm = p => p?.replace(/\D/g, '');

async function getUser(req) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano').eq('id', req.authUser?.id || '__none__').maybeSingle();
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
    const user = await getUser(req);
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
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });
    if (!['hotmart','kiwify','eduzz','stripe','mercadopago','asaas','pagseguro','shopify','woocommerce'].includes(plataforma))
      return res.status(400).json({ erro: 'Plataforma inválida.' });

    const { data, error } = await supabase
      .from('integracoes')
      .insert({
        user_id: user.id,
        grupo_id: user.grupo_ativo,
        plataforma,
        apelido: apelido || null,
        credenciais: encrypt(credenciais || {}),
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

// POST /api/negocios/integracoes/:id/importar-historico
// Importa os últimos 90 dias via API REST da plataforma.
// Roda em background — responde imediatamente com { ok: true, job: 'iniciado' }.
router.post('/integracoes/:id/importar-historico', auth, async (req, res) => {
  try {
    const { data: integ, error } = await supabase
      .from('integracoes').select('*').eq('id', req.params.id).maybeSingle();
    if (error || !integ) return res.status(404).json({ erro: 'Integração não encontrada.' });
    if (integ.status !== 'ativa') return res.status(409).json({ erro: 'Integração não está ativa.' });

    // Marca como sincronizando
    await supabase.from('integracoes')
      .update({ sincronizando: true }).eq('id', integ.id);

    // Responde imediatamente — importação roda em background
    res.json({ ok: true, job: 'iniciado' });

    // Background: descriptografa credenciais e importa
    const integDecrypted = { ...integ, credenciais: decrypt(integ.credenciais) };

    ;(async () => {
      try {
        if (integ.plataforma === 'hotmart') {
          const { importados, ignorados, erros } = await importarHistoricoHotmart(integDecrypted);
          await supabase.from('integracoes').update({
            sincronizando:  false,
            ultimo_sync:    new Date().toISOString(),
            ultimo_erro:    erros > 0 ? `${erros} erros na importação histórica` : null,
            total_eventos:  (integ.total_eventos || 0) + importados,
          }).eq('id', integ.id);
          console.log(`[import] ${integ.plataforma} ${integ.id}: +${importados} eventos`);
        }
      } catch (e) {
        console.error('[import] erro background:', e.message);
        await supabase.from('integracoes').update({
          sincronizando: false,
          ultimo_erro:   e.message?.slice(0, 500),
          status:        'erro',
        }).eq('id', integ.id);
      }
    })();
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
    const user = await getUser(req);
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

// GET /api/negocios/dre-detalhado/:phone?periodo=YYYY-MM
// Quebra cada linha do DRE por plataforma + lista custos por categoria
router.get('/dre-detalhado/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });

    const mesParam = req.query.periodo || new Date().toISOString().slice(0, 7);
    const inicio = `${mesParam}-01`;
    const fimDate = new Date(inicio);
    fimDate.setMonth(fimDate.getMonth() + 1);
    const fim = fimDate.toISOString().slice(0, 10);

    // 1. Eventos do período
    const { data: eventos } = await supabase
      .from('eventos_financeiros').select('*')
      .eq('user_id', user.id)
      .gte('data_evento', inicio).lt('data_evento', fim);

    // 2. Custos do período
    const { data: custos } = await supabase
      .from('custos_negocio').select('*')
      .eq('user_id', user.id)
      .gte('data', inicio).lt('data', fim);

    // 3. Config tributária
    const { data: cfg } = await supabase
      .from('config_negocio').select('*').eq('user_id', user.id).maybeSingle();
    const aliquota = cfg?.aliquota_simples ?? 6.0;
    const reservarImposto = cfg?.reservar_imposto ?? true;

    // Helpers de agregação por plataforma
    const novo = () => ({ total: 0, por_plataforma: {} });
    const acc  = (bag, plataforma, valor) => {
      bag.total += valor;
      bag.por_plataforma[plataforma] = (bag.por_plataforma[plataforma] || 0) + valor;
    };
    const fmtBreakdown = (bag) => ({
      total: bag.total,
      por_plataforma: Object.entries(bag.por_plataforma)
        .map(([plataforma, valor]) => ({ plataforma, valor }))
        .sort((a, b) => b.valor - a.valor),
    });

    const receitaBruta    = novo();
    const taxasPlataforma = novo();
    const taxasGateway    = novo();
    const reembolsos      = novo();
    const chargebacks     = novo();
    const comissoes       = novo();
    const impostoRetido   = novo();

    for (const e of eventos || []) {
      if (e.tipo === 'venda' || e.tipo === 'assinatura_renovacao') {
        acc(receitaBruta,    e.plataforma, e.valor_bruto);
        acc(taxasPlataforma, e.plataforma, e.taxa_plataforma);
        acc(taxasGateway,    e.plataforma, e.taxa_gateway);
        acc(impostoRetido,   e.plataforma, e.imposto);
        acc(comissoes,       e.plataforma, e.comissao_afiliado || 0);
      } else if (e.tipo === 'reembolso') {
        acc(reembolsos,  e.plataforma, e.valor_bruto);
      } else if (e.tipo === 'chargeback') {
        acc(chargebacks, e.plataforma, e.valor_bruto);
      }
    }

    // Receita líquida = bruta - taxas - reembolsos - chargebacks - comissões
    const receitaLiquida = novo();
    for (const plat of Object.keys(receitaBruta.por_plataforma)) {
      const v = (receitaBruta.por_plataforma[plat] || 0)
              - (taxasPlataforma.por_plataforma[plat] || 0)
              - (taxasGateway.por_plataforma[plat] || 0)
              - (reembolsos.por_plataforma[plat] || 0)
              - (chargebacks.por_plataforma[plat] || 0)
              - (comissoes.por_plataforma[plat] || 0);
      acc(receitaLiquida, plat, v);
    }

    // Imposto reserva (sobre receita_apos_taxas)
    const receitaAposTaxas = receitaBruta.total - taxasPlataforma.total - taxasGateway.total
                           - reembolsos.total - chargebacks.total - comissoes.total;
    const impostoReserva = reservarImposto ? Math.round(receitaAposTaxas * (aliquota / 100)) : 0;
    const impostoTotal   = impostoRetido.total + impostoReserva;

    // Custos por categoria
    const custosPorCat = {};
    for (const c of custos || []) {
      custosPorCat[c.categoria] = custosPorCat[c.categoria] || { total: 0, itens: [] };
      custosPorCat[c.categoria].total += c.valor;
      custosPorCat[c.categoria].itens.push({
        id: c.id, descricao: c.descricao, valor: c.valor, data: c.data, fornecedor: c.fornecedor
      });
    }
    const custosTotal = Object.values(custosPorCat).reduce((s, v) => s + v.total, 0);

    const lucroLiquido = (receitaLiquida.total - impostoReserva) - custosTotal;

    res.json({
      periodo: inicio,
      receita_bruta:    fmtBreakdown(receitaBruta),
      taxas_plataforma: fmtBreakdown(taxasPlataforma),
      taxas_gateway:    fmtBreakdown(taxasGateway),
      reembolsos:       fmtBreakdown(reembolsos),
      chargebacks:      fmtBreakdown(chargebacks),
      comissoes:        fmtBreakdown(comissoes),
      impostos: {
        total: impostoTotal,
        retido_origem: impostoRetido.total,
        reserva_simples: impostoReserva,
        aliquota_aplicada: aliquota,
      },
      receita_liquida:  fmtBreakdown(receitaLiquida),
      custos: {
        total: custosTotal,
        por_categoria: Object.entries(custosPorCat)
          .map(([categoria, v]) => ({ categoria, total: v.total, itens: v.itens }))
          .sort((a, b) => b.total - a.total),
      },
      lucro_liquido: lucroLiquido,
      margem_pct: receitaBruta.total > 0
        ? Number((lucroLiquido / receitaBruta.total * 100).toFixed(2))
        : 0,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// GET /api/negocios/forecast/:phone
// Projeção de receita/lucro para os próximos 3 meses baseado nos últimos 6.
// Algoritmo: EMA (exponential moving average) + ajuste de tendência linear.
router.get('/forecast/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });

    // Pega últimos 6 meses de snapshots
    const meses = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      d.setDate(1);
      meses.push(d.toISOString().slice(0, 10));
    }

    const { data: snaps } = await supabase
      .from('dre_snapshots')
      .select('periodo, receita_bruta, lucro_liquido, custos_total, total_vendas')
      .eq('user_id', user.id)
      .in('periodo', meses);

    // Garante todos 6 meses (mês sem dado vira zero)
    const mapa = Object.fromEntries((snaps || []).map(s => [s.periodo, s]));
    const historico = meses.map(m => ({
      periodo: m,
      receita_bruta: mapa[m]?.receita_bruta || 0,
      lucro_liquido: mapa[m]?.lucro_liquido || 0,
      custos_total:  mapa[m]?.custos_total  || 0,
      total_vendas:  mapa[m]?.total_vendas  || 0,
      tipo: 'historico',
    }));

    // Quantos meses têm dados? Se < 2, forecast não faz sentido
    const comDados = historico.filter(h => h.receita_bruta > 0).length;
    if (comDados < 2) {
      return res.json({
        historico,
        projecao: [],
        confianca: 'baixa',
        motivo: 'É necessário ao menos 2 meses de dados pra fazer previsões.',
      });
    }

    // EMA com alpha = 0.4 (mais peso aos meses recentes)
    const alpha = 0.4;
    const ema = (campo) => {
      const vals = historico.map(h => h[campo]);
      let acc = vals[0];
      for (let i = 1; i < vals.length; i++) {
        acc = alpha * vals[i] + (1 - alpha) * acc;
      }
      return acc;
    };

    // Tendência linear simples (regressão pelos mínimos quadrados)
    const tendencia = (campo) => {
      const xs = historico.map((_, i) => i);
      const ys = historico.map(h => h[campo]);
      const n = xs.length;
      const sumX = xs.reduce((a, b) => a + b, 0);
      const sumY = ys.reduce((a, b) => a + b, 0);
      const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
      const sumX2 = xs.reduce((s, x) => s + x * x, 0);
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
      return slope;
    };

    const receitaEma   = ema('receita_bruta');
    const lucroEma     = ema('lucro_liquido');
    const custosEma    = ema('custos_total');
    const vendasEma    = ema('total_vendas');
    const receitaSlope = tendencia('receita_bruta');
    const lucroSlope   = tendencia('lucro_liquido');

    const projecao = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() + i);
      d.setDate(1);
      // Combina EMA com slope (tendência aplicada gradualmente)
      const receita = Math.max(0, Math.round(receitaEma + receitaSlope * i));
      const lucro   = Math.round(lucroEma + lucroSlope * i);
      projecao.push({
        periodo:        d.toISOString().slice(0, 10),
        receita_bruta:  receita,
        lucro_liquido:  lucro,
        custos_total:   Math.max(0, Math.round(custosEma)),
        total_vendas:   Math.max(0, Math.round(vendasEma)),
        tipo: 'projecao',
      });
    }

    const confianca = comDados >= 5 ? 'alta' : comDados >= 3 ? 'media' : 'baixa';

    res.json({
      historico,
      projecao,
      confianca,
      meta: {
        receita_media_6m:    Math.round(historico.reduce((s, h) => s + h.receita_bruta, 0) / 6),
        lucro_medio_6m:      Math.round(historico.reduce((s, h) => s + h.lucro_liquido, 0) / 6),
        tendencia_receita:   receitaSlope > 0 ? 'crescimento' : receitaSlope < 0 ? 'queda' : 'estavel',
        tendencia_lucro:     lucroSlope > 0 ? 'crescimento' : lucroSlope < 0 ? 'queda' : 'estavel',
        meses_com_dados:     comDados,
      },
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /api/negocios/dre/recalcular — { phone, periodo: 'YYYY-MM' }
router.post('/dre/recalcular', auth, async (req, res) => {
  try {
    const { phone, periodo } = req.body;
    const user = await getUser(req);
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
    const user = await getUser(req);
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
    const user = await getUser(req);
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
    const user = await getUser(req);
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
    const user = await getUser(req);
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
    const user = await getUser(req);
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
    const user = await getUser(req);
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

// GET /api/negocios/wrapped/:phone?periodo=YYYY-MM
// Retorna pacote de dados curado pros slides do Wrapped
router.get('/wrapped/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });

    const mesParam = req.query.periodo || new Date().toISOString().slice(0, 7);
    const inicio = `${mesParam}-01`;
    const fimDate = new Date(inicio); fimDate.setMonth(fimDate.getMonth() + 1);
    const fim = fimDate.toISOString().slice(0, 10);

    // Snapshot DRE
    let { data: snap } = await supabase
      .from('dre_snapshots').select('*').eq('user_id', user.id).eq('periodo', inicio).maybeSingle();
    if (!snap) snap = await gerarDre(user.id, user.grupo_ativo, inicio);

    // Mês anterior pra comparação
    const dAnt = new Date(inicio); dAnt.setMonth(dAnt.getMonth() - 1);
    const periodoAnt = dAnt.toISOString().slice(0, 10);
    const { data: snapAnt } = await supabase
      .from('dre_snapshots').select('*').eq('user_id', user.id).eq('periodo', periodoAnt).maybeSingle();

    // Melhor dia do mês (maior receita)
    const { data: eventos } = await supabase
      .from('eventos_financeiros')
      .select('data_evento, valor_bruto, tipo, plataforma, comprador_nome, comprador_email')
      .eq('user_id', user.id)
      .gte('data_evento', inicio).lt('data_evento', fim)
      .in('tipo', ['venda', 'assinatura_renovacao']);

    const porDia = {};
    const compradoresUnicos = new Set();
    for (const e of eventos || []) {
      const dia = e.data_evento.slice(0, 10);
      porDia[dia] = (porDia[dia] || 0) + e.valor_bruto;
      if (e.comprador_email) compradoresUnicos.add(e.comprador_email);
    }
    const dias = Object.entries(porDia).sort((a, b) => b[1] - a[1]);
    const melhorDia = dias[0]
      ? { data: dias[0][0], valor: dias[0][1] }
      : null;

    // Hora pico (qual hora do dia mais vendeu)
    const porHora = Array(24).fill(0);
    for (const e of eventos || []) {
      const h = new Date(e.data_evento).getHours();
      porHora[h]++;
    }
    const horaPico = porHora.indexOf(Math.max(...porHora));

    // Delta vs anterior
    const deltaLucro = snapAnt?.lucro_liquido
      ? ((snap.lucro_liquido - snapAnt.lucro_liquido) / Math.abs(snapAnt.lucro_liquido)) * 100
      : null;
    const deltaVendas = snapAnt?.total_vendas
      ? ((snap.total_vendas - snapAnt.total_vendas) / snapAnt.total_vendas) * 100
      : null;

    res.json({
      periodo: inicio,
      receita_bruta:  snap.receita_bruta,
      lucro_liquido:  snap.lucro_liquido,
      margem_pct:     snap.margem_pct,
      total_vendas:   snap.total_vendas,
      ticket_medio:   snap.ticket_medio,
      mrr:            snap.mrr,
      compradores_unicos: compradoresUnicos.size,
      delta_lucro_pct:    deltaLucro,
      delta_vendas_pct:   deltaVendas,
      produto_top:        (snap.por_produto    || [])[0] || null,
      plataforma_top:     (snap.por_plataforma || [])[0] || null,
      melhor_dia:         melhorDia,
      hora_pico:          horaPico,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /api/negocios/insights/gerar — { phone } — força regeneração agora
router.post('/insights/gerar', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!exigirBlack(user)) return res.status(403).json({ erro: 'Apenas plano Black.' });

    const insights = await gerarInsights(user.id, user.grupo_ativo);
    res.json({ ok: true, gerados: insights.length, insights });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// CONCILIAÇÃO
// ─────────────────────────────────────────────────────────────────

router.get('/conciliacao/sugerir/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const sugestoes = await sugerirConciliacao(user.id, user.grupo_ativo);

    // Hidrata cada par com dados pra UI (nomes, valores, datas)
    const hidratado = [];
    for (const s of sugestoes) {
      const [{ data: ev }, { data: tr }] = await Promise.all([
        supabase.from('eventos_financeiros')
          .select('id, plataforma, produto_nome, comprador_nome, valor_liquido, data_evento')
          .eq('id', s.evento_id).maybeSingle(),
        supabase.from('transacoes')
          .select('id, descricao, observacao, valor, data, carteira_nome')
          .eq('id', s.transacao_id).maybeSingle(),
      ]);
      if (ev && tr) hidratado.push({ ...s, evento: ev, transacao: tr });
    }
    res.json(hidratado);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// GET /api/negocios/conciliacao/conciliadas/:phone — já conciliados
router.get('/conciliacao/conciliadas/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const { data, error } = await supabase
      .from('conciliacao_negocio')
      .select(`
        id, match_tipo, confianca, conciliado_em,
        evento:eventos_financeiros (id, plataforma, produto_nome, comprador_nome, valor_liquido, data_evento),
        transacao:transacoes (id, descricao, observacao, valor, data, carteira_nome)
      `)
      .eq('user_id', user.id)
      .order('conciliado_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// DELETE /api/negocios/conciliacao/:id — desfaz conciliação
router.delete('/conciliacao/:id', auth, async (req, res) => {
  try {
    const { data: row } = await supabase
      .from('conciliacao_negocio').select('evento_id').eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ erro: 'Conciliação não encontrada.' });
    await supabase.from('conciliacao_negocio').delete().eq('id', req.params.id);
    await supabase.from('eventos_financeiros')
      .update({ conciliado: false, transacao_id: null })
      .eq('id', row.evento_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/conciliacao', auth, async (req, res) => {
  try {
    const { phone, evento_id, transacao_id, match_tipo } = req.body;
    const user = await getUser(req);
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
