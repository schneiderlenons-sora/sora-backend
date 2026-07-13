// =====================================================================
// Open Finance (Polp) — rotas do painel. AGREGADOR-AGNÓSTICO.
//   POST   /api/open-finance/conectar                 inicia conexão → Polp Link
//   GET    /api/open-finance/conexoes                 lista conexões do grupo
//   POST   /api/open-finance/conexoes/:id/sincronizar re-sincroniza sob demanda
//   DELETE /api/open-finance/conexoes/:id             desconecta (mantém histórico)
//
// Enquanto a Polp não estiver configurada (env), tudo responde 503 — não quebra
// nada e a aba /open-finance segue com a mensagem "Em atualização".
// =====================================================================
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const polp     = require('../services/polp');
const polpSync = require('../services/polpSync');

function exigirConfigurado(_req, res, next) {
  if (!polp.configurado()) return res.status(503).json({ erro: 'Open Finance ainda não está configurado no servidor.' });
  next();
}

// Inicia uma conexão → devolve a URL do Polp Link pro usuário autorizar o banco.
router.post('/conectar', auth, exigirConfigurado, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const redirectUrl = `${process.env.APP_URL || 'https://forsora.com'}/open-finance`;
    const webhookUrl  = process.env.BACKEND_URL ? `${process.env.BACKEND_URL}/api/webhooks/polp` : undefined;
    const { externalId, linkUrl } = await polp.iniciarConexao({
      connector: req.body?.connector, redirectUrl, webhookUrl, externalUserId: req.userId,
    });
    if (externalId) {
      await supabase.from('of_conexoes').upsert({
        provider: 'polp', external_id: externalId, user_id: req.userId, grupo_id: req.grupoId,
        instituicao: req.body?.connector || null, status: 'updating',
      }, { onConflict: 'provider,external_id' });
    }
    res.json({ ok: true, externalId, linkUrl });
  } catch (err) {
    console.error('[open-finance/conectar]', err.message);
    res.status(500).json({ erro: 'Não consegui iniciar a conexão.' });
  }
});

// Conexões do grupo ativo.
router.get('/conexoes', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    if (!grupoId) return res.json({ conexoes: [] });
    const { data } = await supabase.from('of_conexoes')
      .select('external_id, instituicao, status, ultimo_erro, ultima_sync, created_at')
      .eq('grupo_id', grupoId).order('created_at', { ascending: false });
    res.json({ conexoes: data || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Re-sincroniza sob demanda ("Sincronizar agora").
router.post('/conexoes/:externalId/sincronizar', auth, exigirConfigurado, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { data: c } = await supabase.from('of_conexoes').select('external_id')
      .eq('external_id', req.params.externalId).eq('grupo_id', req.grupoId).maybeSingle();
    if (!c) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    const r = await polpSync.sincronizarConexao(req.params.externalId, { dias: 180 });
    res.json({ ok: !r?.erro, ...r });
  } catch (err) {
    console.error('[open-finance/sync]', err.message);
    res.status(500).json({ erro: 'Não consegui sincronizar agora.' });
  }
});

// Desconecta: remove o vínculo (histórico fica) + apaga no provedor.
router.delete('/conexoes/:externalId', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { data: c } = await supabase.from('of_conexoes').select('id')
      .eq('external_id', req.params.externalId).eq('grupo_id', req.grupoId).maybeSingle();
    if (!c) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    await supabase.from('of_conexoes').delete().eq('id', c.id);
    await polp.removerConexao(req.params.externalId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
