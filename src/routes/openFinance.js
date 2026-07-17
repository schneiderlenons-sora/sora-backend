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
// Cache em memória: a lista é praticamente estática e a ida até a Polp (que por
// sua vez é proxy da Pluggy) é o que fazia o seletor demorar a abrir. Se a Polp
// falhar mas houver cache velho, serve o velho — melhor que tela vazia.
const INST_TTL = 6 * 60 * 60 * 1000; // 6h
let instCache = { em: 0, lista: null };

router.get('/instituicoes', auth, exigirAcesso, exigirConfigurado, async (_req, res) => {
  const agora = Date.now();
  if (instCache.lista && agora - instCache.em < INST_TTL) {
    res.set('Cache-Control', 'private, max-age=3600');
    return res.json({ instituicoes: instCache.lista, cache: 'hit' });
  }
  try {
    const lista = await polp.listarInstituicoes();
    if (lista && lista.length) instCache = { em: agora, lista };
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ instituicoes: lista });
  } catch (err) {
    console.error('[open-finance/instituicoes]', err.message);
    if (instCache.lista) return res.json({ instituicoes: instCache.lista, cache: 'stale' });
    res.status(500).json({ erro: `Falha ao listar bancos: ${err.message}`.slice(0, 300) });
  }
});

// Conectar: cria a integração e devolve a URL de autorização — o usuário abre,
// autoriza o banco (MFA etc.), e o webhook avisa quando os dados ficam prontos.
router.post('/conectar', auth, exigirAcesso, exigirConfigurado, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { institution_id, cpf, cnpj, instituicao_nome } = req.body || {};
    if (!institution_id) return res.status(400).json({ erro: 'Escolha um banco (institution_id).' });
    const { id, status, urlToAuthenticate } = await polp.criarIntegracao({ institutionId: institution_id, cpf, cnpj });

    // NÃO esperar a url_to_authenticate aqui. Ela só aparece um instante DEPOIS
    // do create (quando o status vira WAITING_USER_INPUT) e ficar em loop de
    // polling dentro da requisição segurava a resposta por até ~7s — era o
    // "demora pra conectar / pra abrir o link". Responde já; o painel abre o
    // modal na hora e busca a URL em GET /conexoes/:id/autorizar.
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
  // Amostra das transações MAIS RECENTES. A API devolve em ordem crescente de
  // data, então as do mês estão no FIM da lista (pegar as 3 primeiras trazia
  // compras de 2025, inúteis pra conferir a fatura do mês).
  out.amostras_tx = [];
  for (const c of (Array.isArray(contas) ? contas : []).slice(0, 4)) {
    try {
      const todas = await polp.listarTransacoes(c.id, null);
      const tx = todas.slice(-3).reverse();
      out.amostras_tx.push({ conta: c.name || c.id, type: c.type, total: todas.length, txs: tx });
    } catch (e) { out.amostras_tx.push({ conta: c.name || c.id, erro: e.message }); }
  }
  // Faturas CRUAS do cartão + saldo AO VIVO. O `balance` que vem em
  // /integrations/:id/accounts é o valor persistido na Polp; /accounts/:id/balance
  // vai no banco na hora. Se os dois divergirem, o nosso está velho.
  out.faturas = [];
  out.saldo_ao_vivo = [];
  out.bills_das_tx = [];
  out.faturas_fora_do_list = [];
  for (const c of (Array.isArray(contas) ? contas : [])) {
    try {
      out.saldo_ao_vivo.push({ conta: c.name || c.id, type: c.type, balance_cache: c.balance, ao_vivo: await polp.saldoAoVivo(c.id) });
    } catch (e) { out.saldo_ao_vivo.push({ conta: c.name || c.id, type: c.type, balance_cache: c.balance, ao_vivo_erro: e.message }); }
    if ((c.type || '').toString().toUpperCase() !== 'CREDIT') continue;

    let bills = [];
    try { bills = await polp.listarFaturas(c.id); out.faturas.push({ conta: c.name || c.id, bills }); }
    catch (e) { out.faturas.push({ conta: c.name || c.id, erro: e.message }); }

    // Cada transação de cartão cita a fatura dela em `bill_id`. Se as compras
    // do mês citarem uma fatura que o List Bills NÃO devolveu, essa fatura
    // existe — e é ela que tem o valor que o app do banco mostra.
    try {
      const txs = await polp.listarTransacoes(c.id, null);
      const idsDoList = new Set((bills || []).map(b => String(b.id)));
      const grupos = new Map();
      for (const t of txs) {
        const k = String(t.bill_id);
        const g = grupos.get(k) || { bill_id: t.bill_id, qtd: 0, soma: 0, de: t.date, ate: t.date };
        g.qtd++; g.soma += Number(t.amount) || 0;
        if (t.date < g.de) g.de = t.date;
        if (t.date > g.ate) g.ate = t.date;
        grupos.set(k, g);
      }
      const lista = [...grupos.values()].map(g => ({
        ...g, soma: Math.round(g.soma * 100) / 100,
        no_list_bills: idsDoList.has(String(g.bill_id)),
      })).sort((a, b) => String(a.ate).localeCompare(String(b.ate)));
      out.bills_das_tx.push({ conta: c.name || c.id, total_tx: txs.length, grupos: lista });

      for (const g of lista) {
        if (g.no_list_bills || g.bill_id == null) continue;
        try { out.faturas_fora_do_list.push({ bill_id: g.bill_id, fatura: await polp.getFatura(g.bill_id) }); }
        catch (e) { out.faturas_fora_do_list.push({ bill_id: g.bill_id, erro: e.message }); }
      }
    } catch (e) { out.bills_das_tx.push({ conta: c.name || c.id, erro: e.message }); }
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
