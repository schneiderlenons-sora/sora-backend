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
const polp     = require('../services/polp');   // trilho Pluggy (usado no /debug)
// Dispatcher dos dois trilhos (Pluggy v1 × Celcoin v2). Nas rotas que operam
// sobre uma conexão existente, o provider vem do BANCO — nunca do cliente.
const providers = require('../services/openFinanceProvider');

/** Trilho pedido na requisição (?provider= ou body.provider). Default: Pluggy. */
function provDaReq(req) {
  return providers.para(
    (req.query && req.query.provider) || (req.body && req.body.provider),
  );
}

function exigirConfigurado(req, res, next) {
  const p = provDaReq(req);
  if (!p.configurado()) {
    return res.status(503).json({
      erro: `Open Finance (${p.rotulo}) ainda não está configurado no servidor.`,
      provider: p.provider,
    });
  }
  next();
}

// Recurso de assinatura RECORRENTE (Básico 1 conexão, Premium 3). Vitalício
// fica de fora — cada conexão tem custo mensal nosso no agregador.
const { acessoOpenFinance } = require('../config/openFinanceAccess');
const MSG_SEM_ACESSO = {
  vitalicio: 'O Open Finance faz parte dos planos por assinatura. No plano vitalício você continua lançando pelo WhatsApp e importando extrato (OFX).',
  plano: 'O Open Finance está nos planos Básico e Premium. Assine pra conectar seu banco.',
  sem_usuario: 'Open Finance ainda não está disponível na sua conta.',
};
async function exigirAcesso(req, res, next) {
  const acesso = await acessoOpenFinance(req.authUser?.id);
  if (!acesso.liberado) {
    return res.status(403).json({
      erro: 'sem_acesso',
      motivo: acesso.motivo,
      mensagem: MSG_SEM_ACESSO[acesso.motivo] || MSG_SEM_ACESSO.sem_usuario,
    });
  }
  req.ofAcesso = acesso; // o /conectar usa o limite
  next();
}

// Instituições disponíveis (pro seletor de banco).
// Cache em memória: a lista é praticamente estática e a ida até a Polp (que por
// sua vez é proxy da Pluggy) é o que fazia o seletor demorar a abrir. Se a Polp
// falhar mas houver cache velho, serve o velho — melhor que tela vazia.
// GET /api/open-finance/status — qual trilho está ativo e o que falta configurar.
// Não expõe segredo: só diz se cada credencial ESTÁ presente.
router.get('/status', auth, exigirAcesso, async (_req, res) => {
  const celcoin = require('../services/polpCelcoin');
  const pluggy  = require('../services/polp');
  res.json({
    provider_padrao: providers.providerPadrao(),
    env_OPEN_FINANCE_PROVIDER: process.env.OPEN_FINANCE_PROVIDER || null,
    celcoin: {
      configurado: celcoin.configurado(),
      client_id: !!(process.env.POLP_CELCOIN_CLIENT_ID || process.env.POLP_CLIENT_ID),
      client_secret: !!(process.env.POLP_CELCOIN_CLIENT_SECRET || process.env.POLP_CLIENT_SECRET),
      usando_credencial_do_v1: !process.env.POLP_CELCOIN_CLIENT_ID && !!process.env.POLP_CLIENT_ID,
      webhook_assinado: !!process.env.POLP_CELCOIN_WEBHOOK_SECRET,
      base: process.env.POLP_CELCOIN_API_URL || 'https://api.polp.com.br/api/v2',
    },
    pluggy: {
      configurado: pluggy.configurado(),
      base: process.env.POLP_API_URL || 'https://api.polp.com.br/api/v1',
    },
  });
});

// GET /api/open-finance/ping — bate na Polp de verdade com a credencial atual.
// Serve pra separar "credencial errada" de "plano inativo" de "tudo certo".
router.get('/ping', auth, exigirAcesso, async (req, res) => {
  const p = provDaReq(req);
  if (!p.configurado()) {
    return res.status(503).json({ provider: p.provider, ok: false, erro: 'credenciais ausentes no servidor' });
  }
  try {
    const lista = await p.listarInstituicoes();
    res.json({ provider: p.provider, ok: true, instituicoes: Array.isArray(lista) ? lista.length : 0 });
  } catch (err) {
    res.status(200).json({
      provider: p.provider, ok: false,
      status: err.status || null,
      erro: String(err.message).slice(0, 300),
      dica: err.status === 402 ? 'Plano inativo ou fatura em atraso NESTE trilho.'
        : err.status === 401 ? 'Credencial inválida (client_id/secret).'
        : err.status === 403 ? 'Conta pendente de aprovação na Polp.' : null,
    });
  }
});

const INST_TTL = 6 * 60 * 60 * 1000; // 6h
// Cache POR TRILHO: a lista de bancos da Celcoin (v2) é diferente da da Pluggy (v1).
const instCache = { };   // provider → { em, lista }

router.get('/instituicoes', auth, exigirAcesso, exigirConfigurado, async (req, res) => {
  const p = provDaReq(req);
  const agora = Date.now();
  const cache = instCache[p.provider];
  if (cache && cache.lista && agora - cache.em < INST_TTL) {
    res.set('Cache-Control', 'private, max-age=3600');
    return res.json({ instituicoes: cache.lista, provider: p.provider, cache: 'hit' });
  }
  try {
    const lista = await p.listarInstituicoes();
    if (lista && lista.length) instCache[p.provider] = { em: agora, lista };
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ instituicoes: lista, provider: p.provider });
  } catch (err) {
    console.error('[open-finance/instituicoes]', err.message);
    if (cache && cache.lista) return res.json({ instituicoes: cache.lista, provider: p.provider, cache: 'stale' });
    res.status(500).json({ erro: `Falha ao listar bancos: ${err.message}`.slice(0, 300) });
  }
});

// Conectar: cria a integração e devolve a URL de autorização — o usuário abre,
// autoriza o banco (MFA etc.), e o webhook avisa quando os dados ficam prontos.
router.post('/conectar', auth, exigirAcesso, exigirConfigurado, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { institution_id, cpf, cnpj, instituicao_nome, credenciais } = req.body || {};
    if (!institution_id) return res.status(400).json({ erro: 'Escolha um banco (institution_id).' });

    // Limite de conexões do plano. Checado ANTES de criar o consentimento: uma
    // conexão criada na Polp e recusada aqui viraria custo sem uso.
    const limite = req.ofAcesso?.limite ?? 0;
    const { count } = await supabase.from('of_conexoes')
      .select('id', { count: 'exact', head: true }).eq('grupo_id', req.grupoId);
    if ((count || 0) >= limite) {
      return res.status(409).json({
        erro: 'limite_conexoes',
        limite,
        conectadas: count || 0,
        mensagem: `Seu plano permite ${limite} ${limite === 1 ? 'conexão' : 'conexões'} de banco. ` +
          'Desconecte um banco pra trocar, ou faça upgrade pra conectar mais.',
      });
    }

    const p = provDaReq(req);
    const { id, status, urlToAuthenticate, produtos, produtosPedidos } = await p.criarConexao({
      institutionId: institution_id, cpf, cnpj, credenciais,
      // `products` só se o cliente pedir explicitamente: no Celcoin, mandar uma
      // lista fixa dá 422 COMBINACAO_PERMISSOES_INCORRETA em banco que não
      // oferece algum item (as regras variam por instituição).
      products: (req.body && req.body.products) || undefined,
    });
    if (produtosPedidos) {
      console.log(`🔗 [${p.provider}] consent ${id} — produtos: ${
        Array.isArray(produtosPedidos) ? produtosPedidos.join(',') : produtosPedidos}`);
    }

    // NÃO esperar a url_to_authenticate aqui. Ela só aparece um instante DEPOIS
    // do create (quando o status vira WAITING_USER_INPUT) e ficar em loop de
    // polling dentro da requisição segurava a resposta por até ~7s — era o
    // "demora pra conectar / pra abrir o link". Responde já; o painel abre o
    // modal na hora e busca a URL em GET /conexoes/:id/autorizar.
    if (id) {
      await supabase.from('of_conexoes').upsert({
        provider: p.provider, external_id: String(id), user_id: req.userId, grupo_id: req.grupoId,
        instituicao: instituicao_nome || String(institution_id), status: (status || 'updating').toLowerCase(),
      }, { onConflict: 'provider,external_id' });
    }
    res.json({
      ok: true, externalId: String(id), status, urlToAuthenticate,
      provider: p.provider, produtos: produtos || null, produtosPedidos: produtosPedidos || null,
    });
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
      .select('external_id, provider, instituicao, status, ultimo_erro, ultima_sync, created_at')
      .eq('grupo_id', grupoId).order('created_at', { ascending: false });
    res.json({ conexoes: data || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Re-sincroniza sob demanda ("Sincronizar agora").
// O trilho sai do BANCO (of_conexoes.provider) — uma conexão Pluggy nunca é
// sincronizada pelo código da Celcoin e vice-versa.
router.post('/conexoes/:externalId/sincronizar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const p = await providers.paraConexao(req.params.externalId, req.grupoId);
    if (!p) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    if (!p.configurado()) {
      return res.status(503).json({ erro: `Open Finance (${p.rotulo}) não está configurado no servidor.` });
    }
    const r = await p.sincronizar(req.params.externalId, { dias: 180 });
    res.json({ ok: !(r && r.erro), provider: p.provider, ...r });
  } catch (err) {
    console.error('[open-finance/sync]', err.message);
    res.status(500).json({ erro: 'Não consegui sincronizar agora.' });
  }
});

// URL de autorização ATUAL de uma conexão pendente (pro botão "Autorizar").
router.get('/conexoes/:externalId/autorizar', auth, exigirAcesso, async (req, res) => {
  try {
    const p = await providers.paraConexao(req.params.externalId, req.grupoId);
    if (!p) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    const g = await p.getConexao(req.params.externalId);
    res.json({
      urlToAuthenticate: (g && (g.url_to_authenticate || g.urlToAuthenticate)) || null,
      status: (g && g.status) || null,
      expiraEm: (g && g.url_to_authenticate_expires_at) || null,
      provider: p.provider,
    });
  } catch (err) {
    res.status(500).json({ erro: `Não consegui buscar a autorização: ${err.message}`.slice(0, 200) });
  }
});

// DIAGNÓSTICO (temporário, allowlist): devolve a RESPOSTA CRUA da Polp pra eu ver
// o formato real de contas/transações/investimentos e ajustar o normalize.
//
// ⚠️ ESTE BLOCO SÓ SERVE PRO TRILHO PLUGGY (v1, `/integrations/:id/...`).
// Conexão do trilho CELCOIN (v2) tem id de CONSENTIMENTO, que não existe como
// integração na v1 — pedir por aqui devolve **HTTP 500 com página HTML de erro**
// SEMPRE, mesmo com o sync funcionando perfeitamente. Um cliente mandou esse
// 500 achando que o Open Finance dele estava quebrado quando na verdade as 648
// transações tinham entrado normalmente: o alarme falso era do nosso botão.
// Por isso o roteamento abaixo é pelo PROVIDER da conexão, igual ao sync.
router.get('/debug/:externalId', auth, exigirAcesso, exigirConfigurado, async (req, res) => {
  const id = req.params.externalId;

  const { data: conexao } = await supabase.from('of_conexoes')
    .select('provider').eq('external_id', id).maybeSingle();
  if ((conexao?.provider || '').includes('celcoin')) {
    // Chamada DIRETA (não redirect): o `fetch` do painel poderia não repassar
    // o Authorization no 307 e o usuário veria "Não autenticado" no lugar do
    // diagnóstico. A query (?cru=1, ?foco=cartoes) segue valendo.
    return diagnosticoCelcoin(req, res);
  }

  // `resumo` primeiro: é o bloco que responde "de onde sai a fatura deste
  // cartão" sem precisar ler o JSON inteiro.
  const out = { externalId: id, provider: conexao?.provider || 'polp (v1)', resumo: [] };
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
  out.parcelamentos = [];
  for (const c of (Array.isArray(contas) ? contas : [])) {
    try {
      out.saldo_ao_vivo.push({ conta: c.name || c.id, type: c.type, balance_cache: c.balance, ao_vivo: await polp.saldoAoVivo(c.id) });
    } catch (e) { out.saldo_ao_vivo.push({ conta: c.name || c.id, type: c.type, balance_cache: c.balance, ao_vivo_erro: e.message }); }
    if ((c.type || '').toString().toUpperCase() !== 'CREDIT') continue;

    let bills = [];
    try { bills = await polp.listarFaturas(c.id); out.faturas.push({ conta: c.name || c.id, bills }); }
    catch (e) { out.faturas.push({ conta: c.name || c.id, erro: e.message }); }

    // Cada fatura com quanto JÁ FOI PAGO nela. Fatura "aberta" = tem valor e
    // ainda sobra saldo a pagar. O erro do MP foi pegar a fatura mais recente
    // sem olhar isso — ela estava quitada (208,77 com FULL_PAYMENT).
    const faturasResumo = (bills || []).map(b => {
      const total = Number(b.total_amount) || 0;
      const pago = (b.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      return {
        vence: String(b.due_date || '').slice(0, 10),
        total,
        pago: Math.round(pago * 100) / 100,
        em_aberto: Math.round((total - pago) * 100) / 100,
      };
    });

    // TESTE DA FÓRMULA (explicada pelo próprio usuário no Nubank):
    //   fatura atual = o que sobrou da fatura FECHADA (não paga)
    //                + compras do ciclo que ainda não entrou em fatura (bill_id null)
    // No Nubank: 2001,64 (sobra da fatura de 09/07) + 843,56 = 2845,20 — que é o
    // que o app mostra. O `balance` (5349,63) não é isso e não deve ser usado.
    let compras_ciclo_aberto = null;
    let acumulado = null;
    try {
      const txs = await polp.listarTransacoes(c.id, null);
      const semFatura = txs.filter(t => t.bill_id == null)
        .sort((a, b) => String(b.date).localeCompare(String(a.date))); // mais nova primeiro
      compras_ciclo_aberto = Math.round(semFatura
        .reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;

      // `bill_id: null` NÃO é "ciclo aberto" — é só "a Polp não amarrou a
      // transação a uma fatura", e isso pega compra velha também (no Nubank deu
      // 3.236,99 onde a fatura pedia 843,56). Como o banco não manda
      // balanceCloseDate, dá pra achar o corte pelo avesso: somando da mais
      // recente pra trás, a linha onde a soma bate com a fatura do app é o
      // primeiro dia do ciclo.
      let acc = 0;
      acumulado = semFatura.slice(0, 60).map(t => {
        acc += Number(t.amount) || 0;
        return {
          data: String(t.date).slice(0, 10),
          valor: t.amount,
          status: t.status,
          soma_dessa_data_pra_ca: Math.round(acc * 100) / 100,
          desc: String(t.description || '').slice(0, 30),
        };
      });
    } catch { /* fica null */ }

    const maisRecente = faturasResumo[0] || null; // List Bills vem por vencimento DESC
    const sobraFechada = maisRecente && maisRecente.em_aberto > 0 ? maisRecente.em_aberto : 0;
    const calculada = compras_ciclo_aberto == null ? null
      : Math.round((sobraFechada + compras_ciclo_aberto) * 100) / 100;

    out.resumo.push({
      conta: c.name || c.id,
      balance_do_banco: c.balance,
      due_date_do_banco: (c.credit_data || {}).balanceDueDate || null,
      close_date_do_banco: (c.credit_data || {}).balanceCloseDate || null,
      // ↓ o teste: `fatura_calculada` tem que bater com o app do banco
      sobra_da_fatura_fechada: sobraFechada,
      compras_ciclo_aberto,
      fatura_calculada: calculada,
      // Onde a soma acumulada bate com (fatura do app − sobra_da_fatura_fechada),
      // ali é o começo do ciclo — e o dia do fechamento sai de graça.
      acumulado_de_tras_pra_frente: acumulado,
      faturas: faturasResumo,
    });

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

    // HIPÓTESE A TESTAR: `balance` é o LIMITE USADO, então inclui parcela a
    // vencer (parcela ocupa limite antes de entrar na fatura). Se for isso:
    //     fatura do mês ≈ balance − parcelas futuras
    // Bate com os dois bancos: MP 904,71 − 196,65 = 708,06 e
    // Nubank 5.349,63 − 2.504,43 = 2.845,20. `fatura_estimada` abaixo é o teste.
    try {
      const parc = await polp.listarParcelamentos(c.id);
      const resumo = parc.map(p => {
        const total = Number(p.total_installments) || 0;
        const pagas = p.paid_installments != null ? Number(p.paid_installments) : null;
        const restantes = pagas != null ? Math.max(total - pagas, 0) : null;
        return {
          descricao: p.description, parcela: p.amount, total_compra: p.total_amount,
          total_parcelas: total, parcelas_pagas: pagas, restantes,
          futuro: restantes != null ? Math.round(restantes * (Number(p.amount) || 0) * 100) / 100 : null,
          de: p.start_date, ate: p.end_date,
          campos_recebidos: Object.keys(p), // a doc cita paid_installments mas não lista o campo
        };
      });
      const futuro = resumo.reduce((s, r) => s + (r.futuro || 0), 0);
      out.parcelamentos.push({
        conta: c.name || c.id,
        qtd: parc.length,
        balance: c.balance,
        parcelas_futuras: Math.round(futuro * 100) / 100,
        fatura_estimada: Math.round(((Number(c.balance) || 0) - futuro) * 100) / 100,
        resumo,
        cru: parc.slice(0, 2),
      });
    } catch (e) { out.parcelamentos.push({ conta: c.name || c.id, erro: e.message }); }
  }
  try { out.investimentos = await polp.listarInvestimentos(id); } catch (e) { out.investimentos_erro = e.message; }
  res.json(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNÓSTICO DO TRILHO CELCOIN (allowlist).
// Mostra o que a Celcoin devolve E como a Sora NORMALIZA cada coisa, lado a
// lado, SEM gravar nada no banco. É assim que se valida a integração com banco
// real antes de deixar o sync escrever: se `normalizado` estiver certo aqui, o
// sync está certo.
// ─────────────────────────────────────────────────────────────────────────────
// Entrada server-to-server: o painel admin (que já validou quem é você) chama
// com o ADMIN_SECRET. É o que faz a URL abrir pelo NAVEGADOR — a rota exige
// token Bearer da sessão, que o navegador não manda, e abrir direto respondia
// "Não autenticado". Sem o header, segue exigindo login normalmente.
function authOuAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.headers['x-admin-secret'] === secret) return next();
  return auth(req, res, () => exigirAcesso(req, res, next));
}

// Handler nomeado: o `/debug/:externalId` (botão do painel) chama ISTO quando a
// conexão é do trilho Celcoin, em vez de perguntar à v1 e receber um 500.
async function diagnosticoCelcoin(req, res) {
  const celcoin = require('../services/polpCelcoin');
  const sync    = require('../services/polpCelcoinSync');
  const { hojeSP, cicloPorCompetencia, competenciaAtual } = require('../services/cicloFatura');
  if (!celcoin.configurado()) {
    return res.status(503).json({ erro: 'Celcoin não configurado (POLP_CELCOIN_CLIENT_ID / _SECRET).' });
  }

  const id = req.params.consentId || req.params.externalId;
  const hoje = hojeSP();
  const cru = req.query.cru === '1';          // ?cru=1 inclui o payload bruto
  // ?foco=cartoes — só o que decide a FATURA. O modo completo faz ~40 chamadas
  // à Polp (contas, 5 famílias de investimento, empréstimos, recorrências) e,
  // somado ao cold start do Render free, estourava o limite de tempo da Vercel:
  // a URL do painel simplesmente não carregava. Aqui cai pra ~8 chamadas.
  const soCartoes = req.query.foco === 'cartoes' || req.query.foco === 'parcelamentos';
  const out = { consentId: id, hoje, foco: soCartoes ? 'cartoes' : 'completo',
                contas: [], cartoes: [], dividas: [], investimentos: [] };

  try { out.consentimento = await celcoin.getConsentimento(id); }
  catch (e) { out.consentimento_erro = e.message; }

  if (!soCartoes) {
    try { out.sync_schedules = await celcoin.syncSchedules(id); }
    catch (e) { out.sync_schedules_erro = e.message; }
  }

  // CONTAS
  if (!soCartoes) try {
    for (const raw of await celcoin.listarContas(id)) {
      const item = { normalizado: sync.normalizeConta(raw) };
      if (cru) item.cru = raw;
      try {
        const txs = await celcoin.listarTransacoesConta(raw.id, { max: 1 });
        item.total_tx_1a_pagina = txs.length;
        item.amostra_tx = txs.slice(0, 3).map((t) => ({ cru: cru ? t : undefined, normalizado: sync.normalizeTxConta(t) }));
        item.ignoradas_lancamento_futuro = txs.filter((t) => t.completed_authorised_payment_type === 'LANCAMENTO_FUTURO').length;
      } catch (e) { item.tx_erro = e.message; }
      out.contas.push(item);
    }
  } catch (e) { out.contas_erro = e.message; }

  // CARTÕES — o ponto mais crítico (fatura, fechamento, vencimento, limite)
  try {
    for (const raw of await celcoin.listarCartoes(id)) {
      const bills = await celcoin.listarFaturas(raw.id).catch(() => []);
      const n = sync.normalizeCartao(raw, bills, hoje);
      const item = {
        normalizado: n,
        // ↓ o teste que importa: `fatura.restante` tem de bater com o app do banco
        conferir: {
          fatura_que_a_sora_vai_mostrar: n.faturaAberta ? n.faturaAberta.restante : null,
          saldo_gravado_na_wallet: n.saldoFatura,
          limite: n.extras.limite,
          fecha_dia: n.extras.dia_fechamento,
          vence_dia: n.extras.dia_vencimento,
          minimo: n.extras.pagamento_minimo,
        },
        faturas: bills.map((b) => ({
          id: b.id,
          fecha: String(b.bill_closing_date || '').slice(0, 10),
          vence: String(b.due_date || '').slice(0, 10),
          total: sync.money(b.bill_total_amount),
          pago: sync.pagoDaFatura(b),
          restante: (sync.money(b.bill_total_amount) ?? 0) - sync.pagoDaFatura(b),
          minimo: sync.money(b.bill_minimum_amount),
          parcelada: !!b.is_instalment,
          encargos: (b.finance_charges || []).map((f) => ({ tipo: f.type, valor: sync.money(f.amount) })),
        })),
        limits_crus: raw.limits,
      };
      if (cru) item.cru = raw;

      // ── O QUE CADA REGRA CANDIDATA DARIA ────────────────────────────────
      // Existe pra encerrar discussão de número por COMPARAÇÃO, em vez de
      // garimpar somas até bater com o app do banco — que é chute com dinheiro.
      // Compare `limite_usado` e cada candidata com o valor que o banco mostra.
      try {
        const lim = sync.limiteTotalDoCartao(raw.limits);
        const todas = await celcoin.listarTransacoesCartao(raw.id, { max: 3 });
        const val = (t) => Math.abs(sync.money(t.brazilian_amount) ?? sync.money(t.amount) ?? 0);
        const ehGasto = (t) => (t.credit_debit_type || '').toString().toUpperCase() !== 'CREDITO';
        const dataDe = (t) => String(t.transaction_date_time || t.bill_post_date || '').slice(0, 10);
        const billAberta = n.faturaAberta && n.faturaAberta.billId;
        const futuras = todas.filter((t) => dataDe(t) > hoje && ehGasto(t)).reduce((s, t) => s + val(t), 0);

        item.conferencia = {
          limite_total: lim.limite,
          limite_usado: lim.usado,
          limite_disponivel: lim.disponivel,
          // Publicado > 0? Então é ELE que manda — não usamos regra nenhuma.
          bill_total_da_aberta: n.faturaAberta ? n.faturaAberta.total : null,
          bill_id_da_aberta: billAberta || null,
          candidatas: {
            // (a) a regra de ouro (limite usado − parcelas a vencer)
            limite_usado_menos_futuras: sync.faturaPorLimite(lim.usado, futuras),
            // (b) só o que o emissor vinculou à fatura aberta
            soma_do_bill_da_aberta: billAberta
              ? Math.round(todas.filter((t) => String(t.bill_id || '') === billAberta && ehGasto(t))
                  .reduce((s, t) => s + val(t), 0) * 100) / 100
              : null,
            // (c) ⭐ O QUE O PAINEL REALMENTE MOSTRA quando o emissor não
            // publicou a fatura (o normal no meio do ciclo, e SEMPRE no MP):
            // soma dos gastos do ciclo real de fechamento. Sem isto o
            // diagnóstico devolvia `null` justamente no caso mais comum e não
            // dava pra comparar nada com o app do banco.
            soma_do_ciclo: (() => {
              const cartao = { dia_fechamento: n.extras.dia_fechamento, dia_vencimento: n.extras.dia_vencimento };
              if (!cartao.dia_fechamento) return null;
              const ciclo = cicloPorCompetencia(cartao, competenciaAtual(cartao, hoje));
              const soma = todas
                .filter((t) => ehGasto(t) && dataDe(t) >= ciclo.ini && dataDe(t) < ciclo.fimExcl)
                .reduce((s, t) => s + val(t), 0);
              return { valor: Math.round(soma * 100) / 100, periodo: `${ciclo.ini} a ${ciclo.fim}`, vence: ciclo.venc };
            })(),
          },
          // É assim que a parcela a vencer aparece — QUANDO aparece.
          tx_com_data_futura: todas.filter((t) => dataDe(t) > hoje).length,
          futuras_somam: Math.round(futuras * 100) / 100,
          tx_sem_bill_id: todas.filter((t) => !t.bill_id).length,
          tx_total: todas.length,
        };
      } catch (e) { item.conferencia_erro = e.message; }

      if (!soCartoes) try {
        const txs = await celcoin.listarTransacoesCartao(raw.id, { max: 1 });
        item.amostra_tx = txs.slice(0, 3).map((t) => ({ cru: cru ? t : undefined, normalizado: sync.normalizeTxCartao(t, hoje) }));
        item.ignoradas_futuro = txs.filter((t) => String(t.transaction_date_time || '').slice(0, 10) > hoje).length;
      } catch (e) { item.tx_erro = e.message; }
      try {
        item.parcelamentos = await celcoin.listarParcelamentos(raw.id);
        // Mede se a correção da Polp (ago/2026) pro parcelamento DUPLICADO
        // chegou, e o que a regra de ouro daria com o dado já deduplicado.
        // `duplicatas: 0` = corrigido. Comparar `com_regra_de_ouro` com o que
        // o app do banco mostra HOJE — é o único juiz.
        const an = sync.analisarParcelamentos(item.parcelamentos);
        const usado = item.conferencia ? item.conferencia.limite_usado : null;
        item.parcelamentos_analise = {
          ...an,
          com_regra_de_ouro: {
            limite_usado: usado,
            cru_todas:         sync.faturaPorLimite(usado, an.futuras.cru.todas_restantes),
            cru_fora_aberta:   sync.faturaPorLimite(usado, an.futuras.cru.fora_da_aberta),
            dedup_todas:       sync.faturaPorLimite(usado, an.futuras.deduplicado.todas_restantes),
            dedup_fora_aberta: sync.faturaPorLimite(usado, an.futuras.deduplicado.fora_da_aberta),
          },
        };
      } catch (e) { item.parcelamentos_erro = e.message; }
      if (!soCartoes) {
        try { item.recorrencias = await celcoin.listarRecorrencias(raw.id); } catch (e) { item.recorrencias_erro = e.message; }
      }
      out.cartoes.push(item);
    }
  } catch (e) { out.cartoes_erro = e.message; }

  // EMPRÉSTIMOS / FINANCIAMENTOS → viram Dívidas
  if (!soCartoes) for (const [kind, fn] of [['emprestimo', 'listarEmprestimos'], ['financiamento', 'listarFinanciamentos']]) {
    try {
      for (const raw of await celcoin[fn](id)) {
        const item = { kind, normalizado: sync.normalizeDivida(raw, kind) };
        if (cru) item.cru = raw;
        out.dividas.push(item);
      }
    } catch (e) { out.dividas.push({ kind, erro: e.message }); }
  }

  // INVESTIMENTOS (5 famílias) → viram linhas na aba Investimentos
  // (a mais cara do diagnóstico: 5 endpoints, cada um paginado)
  if (!soCartoes) try {
    for (const raw of await celcoin.listarInvestimentos(id)) {
      const item = { familia: raw.__familia, normalizado: sync.normalizeInvestimento(raw) };
      if (cru) item.cru = raw;
      out.investimentos.push(item);
    }
  } catch (e) { out.investimentos_erro = e.message; }

  res.json(out);
}

router.get('/debug-celcoin/:consentId', authOuAdmin, diagnosticoCelcoin);

// Desconecta: remove o vínculo (histórico fica) + apaga no provedor.
router.delete('/conexoes/:externalId', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { data: c } = await supabase.from('of_conexoes').select('id, provider')
      .eq('external_id', req.params.externalId).eq('grupo_id', req.grupoId).maybeSingle();
    if (!c) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    await supabase.from('of_conexoes').delete().eq('id', c.id);
    // Revoga no provedor CERTO (revogar consentimento na Celcoin, item na Pluggy).
    await providers.para(c.provider).removerConexao(req.params.externalId);
    res.json({ ok: true, provider: c.provider });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
