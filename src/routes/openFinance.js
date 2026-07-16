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

// Teste fechado: só o dono (allowlist) usa.
const { liberadoOpenFinance } = require('../config/openFinanceAccess');
async function exigirAcesso(req, res, next) {
  if (!(await liberadoOpenFinance(req.authUser?.id))) {
    return res.status(403).json({ erro: 'sem_acesso', mensagem: 'Open Finance ainda não está disponível na sua conta.' });
  }
  next();
}

// Instituições disponíveis (pro seletor de banco).
router.get('/instituicoes', auth, exigirAcesso, exigirConfigurado, async (_req, res) => {
  try {
    res.json({ instituicoes: await polp.listarInstituicoes() });
  } catch (err) {
    console.error('[open-finance/instituicoes]', err.message);
    res.status(500).json({ erro: `Falha ao listar bancos: ${err.message}`.slice(0, 300) });
  }
});

// Conectar: cria a integração e devolve a URL de autorização — o usuário abre,
// autoriza o banco (MFA etc.), e o webhook avisa quando os dados ficam prontos.
router.post('/conectar', auth, exigirAcesso, exigirConfigurado, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { institution_id, cpf, cnpj, instituicao_nome } = req.body || {};
    if (!institution_id) return res.status(400).json({ erro: 'Escolha um banco (institution_id).' });
    let { id, status, urlToAuthenticate } = await polp.criarIntegracao({ institutionId: institution_id, cpf, cnpj });

    // A url_to_authenticate costuma aparecer um instante DEPOIS do create (o
    // status vira WAITING_USER_INPUT). Se não veio, consulta a integração algumas
    // vezes até a URL surgir (ou o status ficar terminal).
    if (id && !urlToAuthenticate) {
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1200));
        try {
          const g = await polp.getIntegracao(id);
          status = g.status || status;
          if (g.url_to_authenticate) { urlToAuthenticate = g.url_to_authenticate; break; }
          const s = (g.status || '').toString().toUpperCase();
          if (s === 'UPDATED' || s === 'LOGIN_ERROR') break;
        } catch { /* tenta de novo */ }
      }
    }

    if (id) {
      await supabase.from('of_conexoes').upsert({
        provider: 'polp', external_id: String(id), user_id: req.userId, grupo_id: req.grupoId,
        instituicao: instituicao_nome || String(institution_id), status: (status || 'updating').toLowerCase(),
      }, { onConflict: 'provider,external_id' });
    }
    res.json({ ok: true, externalId: String(id), status, urlToAuthenticate });
  } catch (err) {
    console.error('[open-finance/conectar]', err.message);
    // Teste fechado (só o dono chega aqui) → devolve o motivo real pra diagnosticar.
    res.status(500).json({ erro: `Falha ao conectar: ${err.message}`.slice(0, 300) });
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

// URL de autorização ATUAL de uma conexão pendente (pro botão "Autorizar").
router.get('/conexoes/:externalId/autorizar', auth, exigirAcesso, exigirConfigurado, async (req, res) => {
  try {
    const g = await polp.getIntegracao(req.params.externalId);
    res.json({ urlToAuthenticate: (g && g.url_to_authenticate) || null, status: (g && g.status) || null });
  } catch (err) {
    res.status(500).json({ erro: `Não consegui buscar a autorização: ${err.message}`.slice(0, 200) });
  }
});

// DIAGNÓSTICO (temporário, allowlist): devolve a RESPOSTA CRUA da Polp pra eu ver
// o formato real de contas/transações/investimentos e ajustar o normalize.
router.get('/debug/:externalId', auth, exigirAcesso, exigirConfigurado, async (req, res) => {
  const id = req.params.externalId;
  const out = { externalId: id };
  let contas = [];
  try { contas = await polp.listarContas(id); out.contas = contas; } catch (e) { out.contas_erro = e.message; }
  // Amostra de transações de CADA conta (inclui o cartão) → pra ver categoria + campos.
  out.amostras_tx = [];
  for (const c of (Array.isArray(contas) ? contas : []).slice(0, 4)) {
    try {
      const tx = (await polp.listarTransacoes(c.id, null, { paginaMax: 1 })).slice(0, 3);
      out.amostras_tx.push({ conta: c.name || c.id, type: c.type, txs: tx });
    } catch (e) { out.amostras_tx.push({ conta: c.name || c.id, erro: e.message }); }
  }
  try { out.investimentos = await polp.listarInvestimentos(id); } catch (e) { out.investimentos_erro = e.message; }
  res.json(out);
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
