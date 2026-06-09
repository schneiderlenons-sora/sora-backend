const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta } = require('../services/contaDebito');
const norm     = p => p?.replace(/\D/g, '');

// Tenta as duas variantes de número brasileiro (com/sem 9º dígito)
function variantesPhone(phone) {
  const p = norm(phone) || '';
  const variantes = [p];
  if (p.length === 13 && p.startsWith('55'))
    variantes.push(p.slice(0, 4) + p.slice(5));
  if (p.length === 12 && p.startsWith('55'))
    variantes.push(p.slice(0, 4) + '9' + p.slice(4));
  return variantes;
}

async function getGrupoId(phone) {
  for (const variante of variantesPhone(phone)) {
    const { data } = await supabase.from('users')
      .select('grupo_ativo').eq('phone', variante).maybeSingle();
    if (data?.grupo_ativo) return data.grupo_ativo;
  }
  return null;
}

// GET /api/wallets/:phone
router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('wallets')
      .select('*').eq('grupo_id', grupoId).order('nome');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { nome, tipo, saldo, limite,
            dia_fechamento, dia_vencimento, bandeira, ultimos4 } = req.body;
    const grupoId = req.grupoId; // grupo do usuário autenticado (exigirPermissao)
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const row = { grupo_id: grupoId, nome, tipo, saldo, limite };
    // Campos de cartão de crédito (migration 023) — só inclui quando enviados
    if (dia_fechamento !== undefined) row.dia_fechamento = dia_fechamento || null;
    if (dia_vencimento !== undefined) row.dia_vencimento = dia_vencimento || null;
    if (bandeira       !== undefined) row.bandeira       = bandeira || null;
    if (ultimos4       !== undefined) row.ultimos4       = ultimos4 || null;

    const { data, error } = await supabase.from('wallets')
      .upsert(row, { onConflict: 'grupo_id,nome' })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets/fatura/pagar — paga a fatura do cartão debitando de uma conta
// (cria a transação de saída na conta escolhida e desconta o saldo).
router.post('/fatura/pagar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { cartao_id, wallet_id, valor } = req.body;
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    if (!wallet_id) return res.status(400).json({ erro: 'Escolha a conta de onde sai o pagamento.' });
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Valor inválido.' });

    const { data: cartao } = await supabase.from('wallets')
      .select('nome').eq('id', cartao_id).eq('grupo_id', grupoId).maybeSingle();

    const debito = await debitarConta({
      grupoId, walletId: wallet_id, valor: v,
      categoria: 'Fatura cartão', observacao: `Fatura ${cartao?.nome || 'cartão'}`,
      userId: req.userId,
    });
    res.json({ ok: true, debito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/wallets/:id — só do próprio grupo (anti-IDOR)
router.delete('/:id', auth, async (req, res) => {
  try {
    await supabase.from('wallets').delete()
      .eq('id', req.params.id).eq('grupo_id', req.authUser?.grupoAtivo || '__nenhum__');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;