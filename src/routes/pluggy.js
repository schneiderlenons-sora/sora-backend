// =====================================================================
// Open Finance via Pluggy — rotas do painel.
//   POST   /api/pluggy/connect-token   gera token pro widget Pluggy Connect
//   POST   /api/pluggy/item            registra a conexão criada no widget + sync
//   GET    /api/pluggy/connections      lista conexões do grupo
//   DELETE /api/pluggy/connections/:id  desconecta (mantém histórico)
// Gate: Premium/Black (como OFX/investimentos).
// =====================================================================
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const pluggy     = require('../services/pluggy');
const pluggySync = require('../services/pluggySync');

// Gate de acesso: Open Finance em rollout fechado (allowlist).
const { liberadoOpenFinance } = require('../config/openFinanceAccess');
async function exigirAcessoOpenFinance(req, res, next) {
  if (!(await liberadoOpenFinance(req.authUser?.id))) {
    return res.status(403).json({ erro: 'sem_acesso', mensagem: 'Open Finance ainda não está disponível na sua conta.' });
  }
  next();
}

// Token pro widget. itemId opcional = reconectar/atualizar uma conexão existente.
router.post('/connect-token', auth, exigirAcessoOpenFinance, async (req, res) => {
  try {
    if (!pluggy.configurado()) return res.status(503).json({ erro: 'Pluggy não configurado no servidor.' });
    const token = await pluggy.criarConnectToken(req.body?.itemId);
    res.json({ connectToken: token });
  } catch (err) {
    console.error('[pluggy/connect-token]', err.message);
    res.status(500).json({ erro: 'Não consegui gerar o token de conexão.' });
  }
});

// Registra o item criado pelo widget e dispara a 1ª sincronização (em background).
router.post('/item', auth, exigirAcessoOpenFinance, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const itemId = (req.body?.itemId || '').toString().trim();
    if (!itemId) return res.status(400).json({ erro: 'itemId obrigatório.' });

    await supabase.from('pluggy_items').upsert({
      item_id: itemId,
      user_id: req.userId,
      grupo_id: req.grupoId,
      connector_nome: req.body?.connectorNome || null,
      status: 'updating',
    }, { onConflict: 'item_id' });

    // Sincroniza o que já estiver pronto; o resto chega pelo webhook item/updated.
    pluggySync.sincronizarItem(itemId).catch(e => console.warn('[pluggy/item] sync inicial:', e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[pluggy/item]', err.message);
    res.status(500).json({ erro: 'Não consegui registrar a conexão.' });
  }
});

// Re-sincroniza uma conexão sob demanda (botão "Sincronizar agora").
router.post('/connections/:itemId/sync', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const { data: item } = await supabase.from('pluggy_items')
      .select('item_id').eq('item_id', itemId).eq('grupo_id', req.grupoId).maybeSingle();
    if (!item) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    // Re-sync manual: janela ampla (180 dias) pra não perder a fatura aberta.
    const r = await pluggySync.sincronizarItem(itemId, { dias: 180 });
    res.json({ ok: !r?.erro, ...r });
  } catch (err) {
    console.error('[pluggy/sync]', err.message);
    res.status(500).json({ erro: 'Não consegui sincronizar agora.' });
  }
});

// Conexões do grupo ativo.
router.get('/connections', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.json({ conexoes: [] });
    const { data } = await supabase.from('pluggy_items')
      .select('item_id, connector_nome, status, ultimo_erro, ultima_sync, created_at')
      .eq('grupo_id', grupoId).order('created_at', { ascending: false });
    res.json({ conexoes: data || [] });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Desconecta: remove o vínculo (histórico de transações/saldos fica) + apaga no Pluggy.
router.delete('/connections/:itemId', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const { data: item } = await supabase.from('pluggy_items')
      .select('item_id').eq('item_id', itemId).eq('grupo_id', req.grupoId).maybeSingle();
    if (!item) return res.status(404).json({ erro: 'Conexão não encontrada.' });

    await supabase.from('pluggy_items').delete().eq('item_id', itemId).eq('grupo_id', req.grupoId);
    await pluggy.apagarItem(itemId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Diagnóstico: quais cartões (final mascarado) aparecem nas transações de
// crédito? Mostra se o banco expõe cada cartão virtual separadamente
// (creditCardMetadata.cardNumber) — base pra decidir se dá pra separar.
router.get('/debug-cartoes', auth, exigirAcessoOpenFinance, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    const { data: items } = await supabase.from('pluggy_items').select('item_id').eq('grupo_id', grupoId);
    const desde = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
    const contas = [];
    for (const it of items || []) {
      let accs = [];
      try { accs = await pluggy.listarContas(it.item_id); } catch {}
      for (const acc of accs) {
        if (acc.type !== 'CREDIT') continue;
        let txs = [];
        try { txs = await pluggy.listarTransacoes(acc.id, desde); } catch {}
        const mapa = new Map();
        let semId = 0;
        for (const t of txs) {
          const cn = t.creditCardMetadata && t.creditCardMetadata.cardNumber;
          if (cn) mapa.set(cn, (mapa.get(cn) || 0) + 1);
          else semId++;
        }
        contas.push({
          conta: acc.name || acc.marketingName || 'Cartão',
          total: txs.length,
          cartoes: [...mapa.entries()].map(([numero, qtd]) => ({ numero, qtd })).sort((a, b) => b.qtd - a.qtd),
          sem_identificacao: semId,
        });
      }
    }
    res.json({ contas });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
