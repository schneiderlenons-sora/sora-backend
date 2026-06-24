const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPlano } = require('../middlewares/plano');
const { exigirPermissao } = require('../middlewares/permissao');
const {
  buscarCotacaoAcao, buscarDividendos, buscarTickers,
  buscarCotacaoCripto, listarCriptos,
} = require('../services/cotacoes');
const { debitarConta } = require('../services/contaDebito');

const norm = p => p?.replace(/\D/g, '');

async function getGrupoId(phone) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('phone', norm(phone)).single();
  return data?.grupo_ativo || null;
}

// ── BUSCAS PÚBLICAS DE COTAÇÃO ───────────────────────────────────

// GET /api/investimentos/buscar-ticker?q=PETR
router.get('/buscar-ticker', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json([]);
  const r = await buscarTickers(q);
  res.json(r);
});

// GET /api/investimentos/buscar-cripto?q=bit
router.get('/buscar-cripto', auth, async (req, res) => {
  const q = (req.query.q || '').toString().toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  const lista = await listarCriptos();
  // Ranking: símbolo/nome exato → começa com → contém. Sem isso, buscar
  // "bitcoin" trazia "anime-bitcoin" etc. antes do Bitcoin de verdade.
  const score = (c) => {
    const n = (c.name || '').toLowerCase(), s = (c.symbol || '').toLowerCase();
    if (s === q) return 100;
    if (n === q) return 90;
    if (s.startsWith(q)) return 70;
    if (n.startsWith(q)) return 60;
    if (s.includes(q)) return 30;
    if (n.includes(q)) return 20;
    return -1;
  };
  res.json(
    lista
      .map(c => ({ c, s: score(c) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map(x => x.c)
  );
});

// ── INVESTIMENTOS ────────────────────────────────────────────────

// GET /api/investimentos/:phone
router.get('/:phone', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('investimentos')
      .select('*').eq('grupo_id', grupoId).order('created_at');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/distribuicao
router.get('/:phone/distribuicao', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data: invs } = await supabase.from('investimentos')
      .select('tipo, valor_atual').eq('grupo_id', grupoId);

    const agrupado = {};
    let total = 0;
    (invs || []).forEach(i => {
      agrupado[i.tipo] = (agrupado[i.tipo] || 0) + i.valor_atual;
      total += i.valor_atual;
    });

    const distribuicao = Object.entries(agrupado).map(([tipo, valor]) => ({
      tipo, valor, percentual: total > 0 ? (valor / total) * 100 : 0
    })).sort((a,b) => b.valor - a.valor);

    res.json({ distribuicao, total });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos
router.post('/', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, tipo, nome, ticker, quantidade, preco_unitario, valor_aportado, data_compra } = req.body;
    const grupoId = await getGrupoId(phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const qtd   = parseFloat(quantidade) || 1;
    const preco = parseFloat(preco_unitario) || parseFloat(valor_aportado);

    const { data } = await supabase.from('investimentos').insert({
      grupo_id: grupoId, tipo, nome,
      ticker: ticker || null,
      quantidade: qtd, preco_unitario: preco,
      valor_aportado: parseFloat(valor_aportado),
      valor_atual: qtd * preco,
      data_compra: data_compra || new Date().toISOString()
    }).select().single();

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/investimentos/:id
router.put('/:id', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const campos = ['nome','ticker','quantidade','preco_unitario','valor_atual','valor_aportado'];
    const update = {};
    campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });
    const { data } = await supabase.from('investimentos')
      .update(update).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/investimentos/:id
router.delete('/:id', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('investimentos').delete().eq('id', req.params.id).eq('grupo_id', req.grupoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── APORTES ──────────────────────────────────────────────────────

// GET /api/investimentos/:phone/aportes
router.get('/:phone/aportes', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('aportes')
      .select('*, investimentos(nome)').eq('grupo_id', grupoId)
      .order('data', { ascending: false }).limit(50);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/aportes
router.post('/aportes', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, valor, investimento_id, descricao } = req.body;
    const grupoId = await getGrupoId(phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const { data: aporte } = await supabase.from('aportes').insert({
      grupo_id: grupoId, valor: parseFloat(valor),
      investimento_id: investimento_id || null,
      descricao: descricao || 'Aporte manual'
    }).select().single();

    // Atualiza o investimento vinculado
    let nomeInv = null;
    if (investimento_id) {
      const { data: inv } = await supabase.from('investimentos')
        .select('nome, valor_aportado, valor_atual').eq('id', investimento_id).single();
      if (inv) {
        nomeInv = inv.nome;
        await supabase.from('investimentos').update({
          valor_aportado: inv.valor_aportado + parseFloat(valor),
          valor_atual:    inv.valor_atual    + parseFloat(valor)
        }).eq('id', investimento_id);
      }
    }

    // Opcional: desconta de uma conta e registra a saída nas transações.
    let debito = null;
    if (req.body.wallet_id) {
      try {
        debito = await debitarConta({
          grupoId, walletId: req.body.wallet_id, valor: parseFloat(valor),
          categoria: 'Investimentos', observacao: `Aporte: ${nomeInv || descricao || 'investimento'}`,
          userId: req.userId,
        });
      } catch (e) { debito = { erro: e.message }; }
    }

    res.json({ ...aporte, debito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── METAS ────────────────────────────────────────────────────────

// GET /api/investimentos/:phone/metas
router.get('/:phone/metas', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('metas')
      .select('*').eq('grupo_id', grupoId);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/metas
router.post('/metas', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, nome, valor_objetivo, prazo_anos, taxa_anual, investimento_id } = req.body;
    const grupoId = await getGrupoId(phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const taxa = parseFloat(taxa_anual) || 10;
    const n    = parseFloat(prazo_anos) * 12;
    const jm   = Math.pow(1 + taxa/100, 1/12) - 1;
    let aporte = (parseFloat(valor_objetivo) * jm) / (Math.pow(1+jm,n) - 1);
    if (!isFinite(aporte)) aporte = parseFloat(valor_objetivo) / n;

    const { data } = await supabase.from('metas').insert({
      grupo_id: grupoId, nome,
      valor_objetivo: parseFloat(valor_objetivo),
      prazo_anos: parseFloat(prazo_anos),
      taxa_anual: taxa,
      aporte_mensal_sugerido: parseFloat(aporte.toFixed(2)),
      investimento_id: investimento_id || null
    }).select().single();

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/investimentos/metas/:id
router.delete('/metas/:id', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('metas').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── COTAÇÕES + RESERVA DE EMERGÊNCIA ─────────────────────────────

// POST /api/investimentos/atualizar-precos/:phone
router.post('/atualizar-precos/:phone', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const { data: invs } = await supabase.from('investimentos').select('*').eq('grupo_id', grupoId);
    let atualizados = 0;

    for (const inv of invs || []) {
      if (!inv.ticker) continue;
      let cotacao = null;
      if (inv.tipo === 'Cripto') {
        cotacao = await buscarCotacaoCripto(inv.ticker.toLowerCase());
      } else if (['Ações', 'FIIs', 'ETFs'].includes(inv.tipo)) {
        cotacao = await buscarCotacaoAcao(inv.ticker);
      }
      if (!cotacao || cotacao.precoAtual == null) continue;

      const valorAtual = cotacao.precoAtual * (inv.quantidade || 0);
      const divs = ['Ações', 'FIIs', 'ETFs'].includes(inv.tipo)
        ? await buscarDividendos(inv.ticker, inv.data_compra)
        : 0;
      const valorTotal = valorAtual + (divs * (inv.quantidade || 0));
      const rent = inv.valor_aportado > 0 ? (valorTotal - inv.valor_aportado) / inv.valor_aportado : 0;

      await supabase.from('investimentos').update({
        valor_atual:           valorAtual,
        variacao_dia:          cotacao.variacaoDia ?? 0,
        rentabilidade:         rent,
        dividendos_acumulados: divs * (inv.quantidade || 0),
        ultima_atualizacao:    new Date().toISOString(),
      }).eq('id', inv.id);

      atualizados++;
      await new Promise(r => setTimeout(r, 600)); // rate limit
    }

    res.json({ atualizados, total: invs?.length || 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/reserva/:phone
router.get('/reserva/:phone', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const { data: config } = await supabase.from('reserva_emergencia_config')
      .select('*').eq('grupo_id', grupoId).maybeSingle();

    const { data: invs } = await supabase.from('investimentos')
      .select('valor_atual').eq('grupo_id', grupoId).eq('is_reserva_emergencia', true);
    const valorAtual = (invs || []).reduce((s, i) => s + (i.valor_atual || 0), 0);

    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
    const { data: gastos } = await supabase.from('transacoes')
      .select('valor').eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .gte('data', seisMesesAtras.toISOString().slice(0, 10));

    const totalGastos = (gastos || []).reduce((s, g) => s + (g.valor || 0), 0);
    const gastoMedio  = totalGastos / 6;
    const mesesObj    = config?.meses_objetivo || 6;
    const objetivo    = gastoMedio * mesesObj;
    const pct         = objetivo > 0 ? Math.min((valorAtual / objetivo) * 100, 100) : 0;
    const mesesCob    = gastoMedio > 0 ? valorAtual / gastoMedio : 0;

    res.json({
      valorAtual,
      gastoMedioMensal: gastoMedio,
      mesesObjetivo:    mesesObj,
      valorObjetivo:    objetivo,
      percentual:       pct,
      mesesCobertos:    mesesCob,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/reserva/:phone
router.post('/reserva/:phone', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { meses_objetivo } = req.body;
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    await supabase.from('reserva_emergencia_config').upsert(
      { grupo_id: grupoId, meses_objetivo: parseInt(meses_objetivo, 10) || 6, updated_at: new Date().toISOString() },
      { onConflict: 'grupo_id' }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/patrimonio — evolução histórica
router.get('/:phone/patrimonio', auth, exigirPlano('black'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('patrimonio_historico')
      .select('*').eq('grupo_id', grupoId)
      .order('data', { ascending: true }).limit(365);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;