const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo').eq('phone', norm(phone)).maybeSingle();
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

// GET /api/recorrencias/:phone — lista as recorrências ativas do grupo
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const { data, error } = await supabase.from('recorrencias')
      .select('id, tipo, categoria, valor, dia_vencimento, descricao, carteira, ativa')
      .eq('grupo_id', user.grupo_ativo)
      .eq('ativa', true)
      .order('tipo', { ascending: true })
      .order('dia_vencimento', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/recorrencias — cria gasto/receita fixa (body inclui phone)
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { tipo, categoria, valor, dia_vencimento, descricao, carteira } = req.body;
    const ehReceita = tipo === 'Recebimento';
    const base = {
      grupo_id:       req.grupoId,
      tipo:           ehReceita ? 'Recebimento' : 'Gasto',
      categoria:      categoria || (ehReceita ? '💼 Salário' : 'Outros'),
      valor:          parseFloat(valor),
      dia_vencimento: Math.max(1, Math.min(28, parseInt(dia_vencimento, 10) || 5)),
      descricao:      (descricao || '').toString().slice(0, 120),
      carteira:       carteira || 'Dinheiro',
      ativa:          true,
    };
    // criado_por = usuário logado (dono do lembrete). Tolerante à coluna ausente
    // (pré-migration 052): refaz sem ela se o insert falhar.
    const dono = req.authUser?.id || req.userId || null;
    let { data, error } = await supabase.from('recorrencias').insert({ ...base, criado_por: dono }).select().single();
    if (error) ({ data, error } = await supabase.from('recorrencias').insert(base).select().single());
    if (error) throw error;
    res.json(data);
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
