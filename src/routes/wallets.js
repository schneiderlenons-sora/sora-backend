const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta, registrarTransferencia } = require('../services/contaDebito');
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
    // Join do dono (pra mostrar de quem é a conta em grupos). Fallback sem o
    // embed caso a FK ainda não exista (migration 049 não rodada).
    let { data, error } = await supabase.from('wallets')
      .select('*, dono:users!wallets_criado_por_fkey(id, name, phone, avatar_url, avatar_preset, avatar_cor)')
      .eq('grupo_id', grupoId).order('nome');
    if (error) {
      // Sem a migration 048 (preset/cor): tenta o join só com colunas seguras
      // pra não perder o dono; se a 049 (FK) também faltar, cai pro '*' puro.
      let r = await supabase.from('wallets')
        .select('*, dono:users!wallets_criado_por_fkey(id, name, phone, avatar_url)')
        .eq('grupo_id', grupoId).order('nome');
      if (r.error) r = await supabase.from('wallets').select('*').eq('grupo_id', grupoId).order('nome');
      data = r.data;
    }
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

    // Define o dono SÓ na criação (não sobrescreve em edições/ajustes de saldo).
    // Tolerante: se a coluna criado_por não existe (migration 049), ignora.
    if (data && !data.criado_por && req.userId) {
      const { error: e2 } = await supabase.from('wallets')
        .update({ criado_por: req.userId }).eq('id', data.id);
      if (!e2) data.criado_por = req.userId;
    }
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

// POST /api/wallets/transferir — move valor entre duas contas (ajusta os dois
// saldos) e grava UM registro de transferência (fora dos relatórios de gasto).
router.post('/transferir', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { origem_id, destino_id, valor } = req.body;
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    if (!origem_id || !destino_id) return res.status(400).json({ erro: 'Escolha as contas de origem e destino.' });
    if (origem_id === destino_id)  return res.status(400).json({ erro: 'Origem e destino devem ser diferentes.' });
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Valor inválido.' });

    const { data: contas } = await supabase.from('wallets')
      .select('id, nome, saldo').eq('grupo_id', grupoId).in('id', [origem_id, destino_id]);
    const origem  = (contas || []).find(c => c.id === origem_id);
    const destino = (contas || []).find(c => c.id === destino_id);
    if (!origem || !destino) return res.status(404).json({ erro: 'Conta não encontrada.' });
    if ((origem.saldo || 0) < v) return res.status(400).json({ erro: `Saldo insuficiente em ${origem.nome}.` });

    await supabase.from('wallets').update({ saldo: (origem.saldo || 0) - v }).eq('id', origem.id);
    await supabase.from('wallets').update({ saldo: (destino.saldo || 0) + v }).eq('id', destino.id);

    const tx = await registrarTransferencia({
      grupoId, origemNome: origem.nome, destinoNome: destino.nome, valor: v, userId: req.userId,
    });
    res.json({ ok: true, tx });
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