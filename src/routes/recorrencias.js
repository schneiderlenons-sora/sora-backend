const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

const norm = p => p?.replace(/\D/g, '');

async function getUser(req) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo').eq('id', req.authUser?.id || '__none__').maybeSingle();
  return data;
}

// GET /api/recorrencias/sugestoes — gastos/receitas fixas detectados nas
// transações (Open Finance/OFX) que ainda não viraram recorrência.
// ANTES de /:phone (curinga) pra não ser capturado por ele.
router.get('/sugestoes', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.json({ sugestoes: [] });
    const { detectarRecorrencias } = require('../services/detectarRecorrencias');
    const sugestoes = await detectarRecorrencias(grupoId);
    res.json({ sugestoes });
  } catch (err) {
    console.error('[recorrencias/sugestoes]', err.message);
    res.json({ sugestoes: [] }); // tolerante — nunca quebra a aba
  }
});

// POST /api/recorrencias/dispensar { descricao } — marca uma sugestão como
// dispensada (não volta a aparecer). ANTES de /:phone.
router.post('/dispensar', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    const { chaveDe } = require('../services/detectarRecorrencias');
    const chave = chaveDe(req.body?.descricao || '');
    if (!grupoId || !chave) return res.json({ ok: false });
    await supabase.from('recorrencias_dispensadas')
      .upsert({ grupo_id: grupoId, chave }, { onConflict: 'grupo_id,chave' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[recorrencias/dispensar]', err.message);
    res.json({ ok: false }); // tolerante (ex.: migration 058 não rodou)
  }
});

// GET /api/recorrencias/:phone — lista as recorrências ativas do grupo
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const cols = 'id, tipo, categoria, valor, dia_vencimento, descricao, carteira, ativa';
    const listar = (sel) => supabase.from('recorrencias')
      .select(sel)
      .eq('grupo_id', user.grupo_ativo)
      .eq('ativa', true)
      .order('tipo', { ascending: true })
      .order('dia_vencimento', { ascending: true });
    // Tolerante à migration 066 (valor_variavel): tenta com a coluna, senão sem.
    let { data, error } = await listar(cols + ', valor_variavel');
    if (error) ({ data, error } = await listar(cols));
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/recorrencias — cria gasto/receita fixa (body inclui phone)
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel } = req.body;
    const { criarRecorrencia } = require('../services/recorrencias');
    const row = await criarRecorrencia({
      grupoId:   req.grupoId,
      criadoPor: req.authUser?.id || req.userId || null,
      tipo, categoria, valor, dia_vencimento, descricao, carteira, valor_variavel,
    });
    res.json(row);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/recorrencias/:id — cancela (ativa=false). phone no body p/ permissão.
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('recorrencias').update({ ativa: false })
      .eq('id', req.params.id).eq('grupo_id', req.grupoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
