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
    //
    // ⚠️ CONTA POR USUÁRIO, NÃO POR GRUPO. A franquia vem de
    // `acessoOpenFinance(userId)` — é do PLANO da pessoa. Contando por grupo,
    // quem tivesse dois grupos (gestão compartilhada) ganhava a franquia
    // inteira de novo em cada um: conectava o mesmo banco duas vezes, dava
    // consentimento duas vezes e a Polp cobrava DUAS vezes de nós, porque lá a
    // cobrança é por consentimento ativo. Medido numa conta real: a conexão
    // ficou no grupo pessoal, o usuário trocou pro compartilhado, não a viu
    // mais e ia reconectar.
    const limite = req.ofAcesso?.limite ?? 0;
    const { count } = await supabase.from('of_conexoes')
      .select('id', { count: 'exact', head: true }).eq('user_id', req.userId);
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

// Conexões visíveis pra quem pergunta.
//
// ⚠️ A CONEXÃO SEGUE O DONO, NÃO SÓ O GRUPO. O consentimento é um acordo entre
// a PESSOA e o banco dela — não pertence ao grupo. Antes isto filtrava só por
// `grupo_id = grupoAtivo`, e quem entrava em gestão compartilhada via o Open
// Finance "sumir": a conexão continuava viva e sincronizando no grupo pessoal,
// mas invisível. O caminho natural dali era reconectar — segundo
// consentimento, segunda cobrança da Polp, pelo MESMO banco.
//
// Então devolvemos:
//   · as conexões DESTE grupo (as que o parceiro também vê), e
//   · as MINHAS, feitas em qualquer grupo meu.
//
// `outro_grupo` diz pra tela avisar onde ela vive — sem isso a pessoa veria uma
// conexão listada e nenhuma conta, o que confunde igual.
router.get('/conexoes', auth, async (req, res) => {
  try {
    const grupoId = req.authUser?.grupoAtivo;
    const userId = req.authUser?.id;
    if (!grupoId && !userId) return res.json({ conexoes: [] });

    const filtros = [];
    if (grupoId) filtros.push(`grupo_id.eq.${grupoId}`);
    if (userId) filtros.push(`user_id.eq.${userId}`);
    const { data } = await supabase.from('of_conexoes')
      .select('external_id, provider, instituicao, status, ultimo_erro, ultima_sync, created_at, grupo_id')
      .or(filtros.join(',')).order('created_at', { ascending: false });

    // Nome do grupo de origem, só das que estão fora daqui.
    const fora = [...new Set((data || []).filter((c) => c.grupo_id && c.grupo_id !== grupoId).map((c) => c.grupo_id))];
    const nomes = {};
    if (fora.length) {
      const { data: gs } = await supabase.from('grupos').select('id, nome').in('id', fora);
      (gs || []).forEach((g) => { nomes[g.id] = g.nome; });
    }

    res.json({
      conexoes: (data || []).map((c) => ({
        ...c,
        outro_grupo: !!(c.grupo_id && c.grupo_id !== grupoId),
        grupo_nome: nomes[c.grupo_id] || null,
      })),
    });
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
  // ?foco=saldo — só as CONTAS, pra investigar divergência de saldo contra o
  // app do banco. Mesma razão do foco=cartoes: o modo completo é lento demais
  // pro par Vercel + Render free, e quem está investigando saldo não precisa
  // de cartão, investimento nem empréstimo.
  const soSaldo = req.query.foco === 'saldo';
  const out = { consentId: id, hoje,
                foco: soSaldo ? 'saldo' : soCartoes ? 'cartoes' : 'completo',
                contas: [], cartoes: [], dividas: [], investimentos: [] };

  try { out.consentimento = await celcoin.getConsentimento(id); }
  catch (e) { out.consentimento_erro = e.message; }

  if (!soCartoes && !soSaldo) {
    try { out.sync_schedules = await celcoin.syncSchedules(id); }
    catch (e) { out.sync_schedules_erro = e.message; }
  }

  // CONTAS
  if (!soCartoes) try {
    for (const raw of await celcoin.listarContas(id)) {
      const item = { normalizado: sync.normalizeConta(raw) };
      if (cru) item.cru = raw;

      // ── DE ONDE VEM O SALDO ────────────────────────────────────────────
      // Existe porque um cliente comparou o painel com o app do banco e os
      // números não bateram (Sora R$ 1,00 × Itaú R$ 2.541,12). A doc da
      // Celcoin diz que `available_amount` "não inclui cheque especial,
      // investimentos automáticos nem reservas de saldo" — ou seja, o app do
      // banco pode mostrar um número MAIOR de forma legítima.
      //
      // Sem esta decomposição a investigação vira adivinhação: a Sora guarda
      // só o número final e não dá pra saber QUAL parcela explica a diferença.
      // Aqui os campos aparecem lado a lado, com as somas já prontas.
      try {
        const b = raw.balance || null;
        if (!b) {
          item.saldo_detalhe = { erro: 'conta ainda sem balance (não sincronizou)' };
        } else {
          const n = (v) => sync.money(v) ?? 0;
          const disponivel = n(b.available_amount);
          const investido  = n(b.automatically_invested_amount);
          const bloqueado  = n(b.blocked_amount);
          const cent2 = (x) => Math.round(x * 100) / 100;
          item.saldo_detalhe = {
            usado_pela_sora: disponivel,          // é o que vira wallets.saldo
            available_amount: disponivel,
            automatically_invested_amount: investido,
            blocked_amount: bloqueado,
            has_reserved_balance: b.has_reserved_balance === true,
            // As somas possíveis — respondem "qual delas bate com o app?".
            soma_disponivel_mais_investido: cent2(disponivel + investido),
            soma_tudo: cent2(disponivel + investido + bloqueado),
            atualizado_em: b.update_date_time || b.updated_at || null,
            leia_me: 'Compare com o saldo do app do banco. Batendo com '
              + '`soma_disponivel_mais_investido`, a diferença é aplicação automática. '
              + 'Se `has_reserved_balance` for true, há caixinhas fora dessas somas.',
          };
        }
      } catch (e) { item.saldo_detalhe = { erro: e.message }; }

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
  if (!soSaldo) try {
    for (const raw of await celcoin.listarCartoes(id)) {
      const bills = await celcoin.listarFaturas(raw.id).catch(() => []);
      const n = sync.normalizeCartao(raw, bills, hoje);
      const item = {
        normalizado: n,
        // ↓ o teste que importa: `fatura.restante` tem de bater com o app do banco
        conferir: {
          fatura_que_a_sora_vai_mostrar: n.faturaAberta ? n.faturaAberta.restante : null,
          // ⭐ A fatura em andamento. Desde o breaking change de 24/08/2026 ela
          // vem de `limits[].unbilled_amount` (somado por plástico); o
          // `simulated_bill_total_amount` foi removido da API.
          fatura_simulada: n.faturaSimulada,
          // Cada plástico separado — é o que permite conferir se a soma por
          // `identification_number` está certa quando o total diverge do banco.
          unbilled_por_plastico: (raw.limits || []).map((l) => ({
            plastico: l && l.identification_number,
            tipo: l && l.credit_line_limit_type,
            unbilled: sync.money(l && l.unbilled_amount),
          })),
          unbilled_somado: sync.unbilledDoCartao(raw),
          saldo_gravado_na_wallet: n.saldoFatura,
          // POR QUE o limite não foi adotado. Sem isto, "não veio limite" era
          // indistinguível de "veio e uma trava recusou", e a investigação
          // virava adivinhação.
          limite_motivo: lim.motivo || null,
          limite_regua_de_gasto: lim.usoRef ?? sync.usoConhecido(raw, bills),
          limite: n.extras.limite,
          fecha_dia: n.extras.dia_fechamento,
          vence_dia: n.extras.dia_vencimento,
          minimo: n.extras.pagamento_minimo,
        },
        // ── DE ONDE SAEM AS DATAS ────────────────────────────────────────────
        // O dia de fechamento/vencimento saiu errado num MP real (painel 12/17,
        // app 8/14). Aqui dá pra ver, lado a lado, o que cada candidata daria —
        // sem isso a correção vira chute.
        datas: {
          moda_de_todas: {
            fecha: sync.diaMaisFrequente(bills, 'bill_closing_date'),
            vence: sync.diaMaisFrequente(bills, 'due_date'),
          },
          ultimas_3: (() => {
            const rec = (bills || []).filter((b) => b && b.due_date)
              .sort((a, b) => String(b.due_date).localeCompare(String(a.due_date))).slice(0, 3);
            return {
              fecha: sync.diaMaisFrequente(rec, 'bill_closing_date'),
              vence: sync.diaMaisFrequente(rec, 'due_date'),
              usadas: rec.map((b) => String(b.due_date).slice(0, 10)),
            };
          })(),
          fatura_mais_recente: (() => {
            const u = sync.ultimaFaturaPublicada(bills);
            return u ? { fecha: String(u.bill_closing_date || '').slice(0, 10), vence: String(u.due_date || '').slice(0, 10) } : null;
          })(),
          campos_de_data_no_cartao: Object.keys(raw || {}).filter((k) => /date|day|dia|clos|due/i.test(k))
            .reduce((o, k) => { o[k] = raw[k]; return o; }, {}),
        },
        faturas: bills.map((b) => ({
          id: b.id,
          fecha: String(b.bill_closing_date || '').slice(0, 10),
          vence: String(b.due_date || '').slice(0, 10),
          total: sync.money(b.bill_total_amount),
          simulada: sync.faturaSimulada(b),
          pago: sync.pagoDaFatura(b),
          restante: (sync.money(b.bill_total_amount) ?? 0) - sync.pagoDaFatura(b),
          minimo: sync.money(b.bill_minimum_amount),
          parcelada: !!b.is_instalment,
          encargos: (b.finance_charges || []).map((f) => ({ tipo: f.type, valor: sync.money(f.amount) })),
          // Qualquer campo novo que a Polp tenha passado a mandar na fatura e a
          // gente ainda não lê — é assim que a próxima mudança aparece sozinha.
          campos_desconhecidos: Object.keys(b || {}).filter((k) => ![
            'id', 'bill_closing_date', 'due_date', 'bill_total_amount', 'bill_minimum_amount',
            'payments', 'is_instalment', 'finance_charges', 'simulated_bill_total_amount',
          ].includes(k)),
        })),
        limits_crus: raw.limits,
      };
      if (cru) item.cru = raw;

      // ── O QUE CADA REGRA CANDIDATA DARIA ────────────────────────────────
      // Existe pra encerrar discussão de número por COMPARAÇÃO, em vez de
      // garimpar somas até bater com o app do banco — que é chute com dinheiro.
      // Compare `limite_usado` e cada candidata com o valor que o banco mostra.
      try {
        const lim = sync.limiteTotalDoCartao(raw.limits, sync.usoConhecido(raw, bills));
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

        // ── Linha a linha do ciclo EM ABERTO + o que o sync faz com cada uma.
        //
        // É o instrumento pra "a fatura da Sora está R$ X menor que a do
        // banco". Os contadores agregados diziam "7 lidas" enquanto a base
        // tinha 6, e não havia como saber QUAL sumiu nem por quê — o que
        // sobrava era palpite. Aqui a linha descartada aparece com o motivo.
        item.ciclo_aberto = (() => {
          const cartao = { dia_fechamento: n.extras.dia_fechamento, dia_vencimento: n.extras.dia_vencimento };
          if (!cartao.dia_fechamento) return null;
          const ciclo = cicloPorCompetencia(cartao, competenciaAtual(cartao, hoje));
          const doCiclo = todas.filter((t) => dataDe(t) >= ciclo.ini && dataDe(t) < ciclo.fimExcl);
          const linhas = doCiclo.map((t) => {
            const importada = !!sync.normalizeTxCartao(t, hoje);
            const status = String(t.completed_authorised_payment_type || '') || null;
            return {
              data: dataDe(t),
              descricao: String(t.transaction_name || '').slice(0, 44),
              valor: val(t),
              credito: !ehGasto(t),
              status,
              importada,
              motivo_do_descarte: importada ? null
                : (status === 'LANCAMENTO_FUTURO' || status === 'TRANSACAO_PROCESSANDO')
                  ? `status ${status} (nao efetivada)`
                  : dataDe(t) > hoje ? 'data futura' : 'valor ausente ou outro filtro',
            };
          });
          const soma = (arr) => Math.round(arr.reduce((s2, l) => s2 + (l.credito ? -l.valor : l.valor), 0) * 100) / 100;
          const fora = linhas.filter((l) => !l.importada);
          return {
            periodo: `${ciclo.ini} a ${ciclo.fim}`,
            linhas,
            soma_importadas: soma(linhas.filter((l) => l.importada)),
            descartadas: fora.length,
            descartadas_somam: soma(fora),
          };
        })();
      } catch (e) { item.conferencia_erro = e.message; }

      if (!soCartoes) try {
        const txs = await celcoin.listarTransacoesCartao(raw.id, { max: 1 });
        item.amostra_tx = txs.slice(0, 3).map((t) => ({ cru: cru ? t : undefined, normalizado: sync.normalizeTxCartao(t, hoje) }));
        item.ignoradas_futuro = txs.filter((t) => String(t.transaction_date_time || '').slice(0, 10) > hoje).length;
      } catch (e) { item.tx_erro = e.message; }
      try {
        item.parcelamentos = await celcoin.listarParcelamentos(raw.id);

        // ⚠️ MEDE A REDISTRIBUIÇÃO com o dado VIVO da API. Responde as duas
        // perguntas que sobram quando "a fatura continua errada depois do
        // sync": a API devolveu plano, e quais ocorrências chegam SEM o
        // marcador `charge_identificator`.
        //
        // O marcador é o que empurra a parcela N pra compra + (N−1) meses. Quem
        // chega SEM ele fica na data da COMPRA — e as parcelas do mesmo plano
        // se EMPILHAM no mesmo dia, sumindo das faturas seguintes. Medido no
        // cartão `gold` da jeniffer.jls@: duas linhas de R$ 108,76 no mesmo
        // 2026-05-21, ambas sem marcador, enquanto o banco cobra a terceira num
        // ciclo posterior.
        //
        // ⚠️ NÃO voltar a chamar `sync.redistribuirSemMarcador` aqui: a função
        // foi REMOVIDA. Ela nasceu de uma medição feita no NOSSO banco (que
        // reflete linhas antigas) em vez de na API, e reconstruía a ordem das
        // parcelas por `occurrences` — risco alto pra um problema inexistente.
        // A chamada morta ficou pra trás e aparecia no JSON como
        // `"redistribuicao": { "erro": "... is not a function" }`.
        try {
          const todasTx = await celcoin.listarTransacoesCartao(raw.id, { max: 3 });
          const norm = todasTx.map((t) => sync.normalizeTxCartao(t, hoje));
          // Por plano: o que o sync enxerga de cada ocorrência — é aqui que se
          // vê QUAL guarda barrou a parcela.
          const porId = new Map();
          for (const t of norm) if (t && t.externalId) porId.set(String(t.externalId), t);
          const crus = new Map();
          for (const t of todasTx) if (t && t.id) crus.set(String(t.id), t);
          item.diagnostico_planos = (item.parcelamentos || []).map((pl) => ({
            descricao: pl.description,
            total: pl.totalInstallments,
            pagas: pl.paidInstallments,
            ocorrencias: (pl.occurrences || []).length,
            linhas: (pl.occurrences || []).map((id) => {
              const t = porId.get(String(id));
              const cru = crus.get(String(id));
              return {
                achada: !!t,
                charge: cru ? `${cru.charge_identificator}/${cru.charge_number}` : '(tx não lida)',
                marcador_calculado: t ? (t.parcelaTotal ? `${t.parcelaNum}/${t.parcelaTotal}` : 'nenhum') : null,
                data_calculada: t ? String(t.data).slice(0, 10) : null,
                data_crua: cru ? String(cru.transaction_date_time || '').slice(0, 10) : null,
                valor: t ? t.valor : null,
              };
            }),
          }));
          // Gastos sem marcador, AGRUPADOS por descrição+valor+data. Grupo com
          // 2+ linhas é o sintoma: parcelas do mesmo plano empilhadas no mesmo
          // dia porque não veio `charge_identificator` pra separá-las.
          const semMarcador = norm.filter((t) => t && t.ehGasto && !t.parcelaTotal);
          const pilhas = new Map();
          for (const t of semMarcador) {
            const k = `${String(t.descricao || '').slice(0, 34)}|${t.valor}|${String(t.data).slice(0, 10)}`;
            pilhas.set(k, (pilhas.get(k) || 0) + 1);
          }
          item.redistribuicao = {
            parcelamentos_lidos: (item.parcelamentos || []).length,
            transacoes_sem_marcador: semMarcador.length,
            empilhadas: [...pilhas.entries()]
              .filter(([, n]) => n > 1)
              .map(([k, n]) => {
                const [descricao, valor, data] = k.split('|');
                return { descricao, valor: Number(valor), data, linhas: n };
              })
              .sort((a, b) => b.linhas - a.linhas),
          };
        } catch (e) { item.redistribuicao = { erro: e.message }; }
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
  if (!soCartoes && !soSaldo) for (const [kind, fn] of [["emprestimo", "listarEmprestimos"], ["financiamento", "listarFinanciamentos"]]) {
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
  if (!soCartoes && !soSaldo) try {
    for (const raw of await celcoin.listarInvestimentos(id)) {
      const item = { familia: raw.__familia, normalizado: sync.normalizeInvestimento(raw) };
      if (cru) item.cru = raw;
      out.investimentos.push(item);
    }
  } catch (e) { out.investimentos_erro = e.message; }

  res.json(out);
}

router.get('/debug-celcoin/:consentId', authOuAdmin, diagnosticoCelcoin);

// GET /api/open-finance/consents-reconciliar  (só com x-admin-secret)
//
// ⚠️ RECONCILIA O QUE A POLP COBRA COM O QUE A SORA USA. O painel da Polp
// mostrou 35 consentimentos enquanto a Sora tinha 24 conexões — e a conta lá
// é POR CONEXÃO, então a diferença é dinheiro.
//
// As causas possíveis, que este endpoint separa:
//   · consentimento abandonado no meio (nunca chegou ao callback, então nunca
//     virou linha nossa);
//   · revogado/expirado que a Polp mantém no histórico;
//   · RECONEXÃO — cada uma cria um consent NOVO lá e o antigo fica. Este é o
//     caro: some da nossa tabela e continua na fatura deles.
//
// Só admin: lista consentimento de TODOS os clientes.
router.get('/consents-reconciliar', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(403).json({ erro: 'Só com x-admin-secret.' });
  }
  const celcoin = require('../services/polpCelcoin');
  if (!celcoin.configurado()) return res.status(503).json({ erro: 'Celcoin não configurada.' });
  try {
    const consents = await celcoin.listarConsentimentos();
    const { data: nossas } = await supabase.from('of_conexoes')
      .select('external_id, status, instituicao, grupo_id, created_at').eq('provider', 'polp-celcoin');
    const meus = new Map((nossas || []).map((c) => [String(c.external_id), c]));

    const porStatus = {};
    const orfaos = [];      // existe na Polp e NÃO na Sora → candidato a revogar
    for (const c of consents || []) {
      const st = String(c.status || c.status_label || '?');
      porStatus[st] = (porStatus[st] || 0) + 1;
      if (!meus.has(String(c.id))) {
        orfaos.push({
          id: c.id, status: st, execution_status: c.execution_status || null,
          institution_id: c.institution_id || null,
          cliente_user_id: c.cliente_user_id || null,
          created_at: c.created_at || null,
        });
      }
    }
    // ── DESCONEXÕES DO CICLO (migration 129) ───────────────────────────────
    //
    // A Polp cobra por consentimento ativo NO CICLO, não por estoque no fim do
    // mês. Uma conexão que viveu 20 dias e foi desconectada entra na fatura
    // daquele mês e some da foto — é a explicação mais provável pros 35 do
    // painel contra os 25 da API. Sem este bloco a diferença fica sem resposta.
    //
    // `?desde=YYYY-MM-DD` recorta o ciclo que se quer conferir.
    let desconectadas = null;
    try {
      const desde = String(req.query.desde || '').slice(0, 10);
      let qh = supabase.from('of_conexoes_historico')
        .select('external_id, instituicao, status_final, criada_em, desconectada_em, motivo')
        .order('desconectada_em', { ascending: false }).limit(200);
      if (desde) qh = qh.gte('desconectada_em', desde);
      const { data: hist, error: eh } = await qh;
      if (eh) throw eh;
      desconectadas = { total: (hist || []).length, desde: desde || 'sempre', itens: hist || [] };
    } catch { /* migration 129 pendente */ }

    const idsPolp = new Set((consents || []).map((c) => String(c.id)));
    const soNaSora = (nossas || [])
      .filter((c) => !idsPolp.has(String(c.external_id)))
      .map((c) => ({ external_id: c.external_id, status: c.status, instituicao: c.instituicao }));

    res.json({
      na_polp: (consents || []).length,
      na_sora: (nossas || []).length,
      diferenca: (consents || []).length - (nossas || []).length,
      polp_por_status: porStatus,
      // O que a Polp conhece e nós não. É aqui que mora a cobrança extra.
      orfaos_na_polp: orfaos.length,
      orfaos: orfaos.slice(0, 60),
      // O inverso: temos a linha e a Polp não conhece (sinal de dado velho).
      so_na_sora: soNaSora,
      // Quantas SAÍRAM — some da foto, mas já foi cobrada no ciclo em que viveu.
      desconectadas,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Desconecta: remove o vínculo (histórico fica) + apaga no provedor.
router.delete('/conexoes/:externalId', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { data: c } = await supabase.from('of_conexoes').select('*')
      .eq('external_id', req.params.externalId).eq('grupo_id', req.grupoId).maybeSingle();
    if (!c) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    // ⚠️ GUARDA ANTES DE APAGAR (migration 129). A fatura da Polp cobra por
    // consentimento ativo NO CICLO, então uma conexão que viveu 20 dias e foi
    // desconectada continua sendo cobrada naquele mês. Sem este registro não
    // há como conferir a conta deles — foi exatamente o que impediu de explicar
    // os 35 do painel contra os 24 nossos.
    //
    // Tolerante: se a migration não rodou, a desconexão acontece do mesmo jeito.
    // Perder o histórico é ruim; impedir o cliente de desconectar o banco é pior.
    try {
      await supabase.from('of_conexoes_historico').insert({
        grupo_id: c.grupo_id, user_id: c.user_id || null,
        provider: c.provider, external_id: String(c.external_id),
        instituicao: c.instituicao || null, status_final: c.status || null,
        criada_em: c.created_at || null, motivo: 'usuario',
      });
    } catch { /* migration 129 pendente */ }

    await supabase.from('of_conexoes').delete().eq('id', c.id);
    // Revoga no provedor CERTO (revogar consentimento na Celcoin, item na Pluggy).
    await providers.para(c.provider).removerConexao(req.params.externalId);
    res.json({ ok: true, provider: c.provider });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});


// ── TRAZER UMA CONEXÃO (E OS DADOS DELA) PRO GRUPO ATUAL ────────────────────
//
// Existe porque a conexão fica no grupo em que foi criada. Quem conectou o
// banco no grupo pessoal e depois passou a usar gestão compartilhada via o
// Open Finance "sumir" — e o caminho natural dali era reconectar, que é um
// SEGUNDO consentimento pelo mesmo banco, cobrado de novo pela Polp.
//
// ⚠️ É EXPLÍCITO, NÃO AUTOMÁTICO. Mover sozinho ao trocar de grupo exporia o
// banco de uma pessoa aos outros membros no instante em que ela trocasse de
// contexto — decisão de privacidade que o sistema não pode tomar pelo dono.
//
// ⚠️ SÓ O DONO DO CONSENTIMENTO MOVE. O consentimento é um acordo entre a
// PESSOA e o banco dela; um admin do grupo não pode arrastar o banco de outro.
//
// ⚠️ QUAIS CARTEIRAS SÃO DESTA CONEXÃO: `wallets` não guarda vínculo com a
// conexão que a criou — só `of_conta_id`. Então perguntamos ao PROVEDOR quais
// contas e cartões pertencem a este consentimento e movemos só essas. Sem isso,
// num grupo com duas conexões, mover uma arrastaria as carteiras da outra.
// Se o provedor não responder, só seguimos quando o grupo de origem tem UMA
// conexão — aí a atribuição é inequívoca. Caso contrário, recusa.
//
// Idempotente: procura as carteiras na origem E no destino, então repetir a
// chamada termina um movimento que tenha falhado no meio.
router.post('/conexoes/:externalId/mover', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    // Destino explícito no corpo, ou o grupo ativo. O corpo existe pra DAR A
    // VOLTA sem trocar de grupo antes: quem trouxe o banco pro compartilhado e
    // se arrependeu escolhe o pessoal na própria tela.
    const destino = (req.body && req.body.grupo_id) || req.authUser?.grupoAtivo;
    if (!destino) return res.status(400).json({ erro: 'Sem grupo de destino.' });

    // ⚠️ SÓ PRA GRUPO DELE. Sem esta checagem, mandar um `grupo_id` qualquer no
    // corpo empurraria as contas e o histórico pro grupo de um estranho.
    if (destino !== req.authUser?.grupoAtivo) {
      const { data: membro } = await supabase.from('grupo_membros')
        .select('id').eq('grupo_id', destino).eq('user_id', req.authUser?.id).maybeSingle();
      const { data: dono } = await supabase.from('grupos')
        .select('dono_id').eq('id', destino).maybeSingle();
      if (!membro && dono?.dono_id !== req.authUser?.id) {
        return res.status(403).json({ erro: 'Você não participa desse grupo.' });
      }
    }

    const { data: cx } = await supabase.from('of_conexoes').select('*')
      .eq('external_id', req.params.externalId).maybeSingle();
    if (!cx) return res.status(404).json({ erro: 'Conexão não encontrada.' });
    if (cx.user_id && cx.user_id !== req.authUser?.id) {
      return res.status(403).json({
        erro: 'nao_e_dono',
        mensagem: 'Só quem conectou este banco pode movê-lo — o consentimento é pessoal.',
      });
    }
    const origem = cx.grupo_id;
    if (origem === destino) return res.json({ ok: true, jaEstava: true, movidas: 0 });

    // 1. Contas/cartões DESTE consentimento, segundo o provedor.
    let idsDoConsent = null;
    try {
      if (cx.provider === 'polp-celcoin') {
        const celcoin = require('../services/polpCelcoin');
        const [contas, cartoes] = await Promise.all([
          celcoin.listarContas(cx.external_id).catch(() => []),
          celcoin.listarCartoes(cx.external_id).catch(() => []),
        ]);
        const ids = [...(contas || []), ...(cartoes || [])].map((x) => String(x.id)).filter(Boolean);
        if (ids.length) idsDoConsent = new Set(ids);
      }
    } catch { /* cai no fallback abaixo */ }

    if (!idsDoConsent) {
      const { count } = await supabase.from('of_conexoes')
        .select('id', { count: 'exact', head: true }).eq('grupo_id', origem);
      if ((count || 0) > 1) {
        return res.status(409).json({
          erro: 'ambiguo',
          mensagem: 'Não consegui confirmar com o banco quais contas são desta conexão, e o grupo '
            + 'de origem tem mais de uma. Tente de novo em alguns minutos.',
        });
      }
    }

    // 2. Carteiras a mover — na origem E no destino (idempotência).
    const { data: candidatas } = await supabase.from('wallets')
      .select('id, nome, of_conta_id').in('grupo_id', [origem, destino]).not('of_conta_id', 'is', null);
    const minhas = (candidatas || []).filter((w) => !idsDoConsent || idsDoConsent.has(String(w.of_conta_id)));
    if (!minhas.length) return res.json({ ok: true, movidas: 0, aviso: 'Nenhuma conta encontrada pra esta conexão.' });

    // 3. Colisão de nome no destino. `wallets` tem unique (grupo_id, nome) e as
    //    transações apontam pra carteira POR NOME — renomear no meio do caminho
    //    deixaria histórico órfão. Melhor recusar e explicar.
    const nomes = [...new Set(minhas.map((w) => w.nome))];
    const idsMinhas = new Set(minhas.map((w) => w.id));
    const { data: jaLa } = await supabase.from('wallets')
      .select('id, nome').eq('grupo_id', destino).in('nome', nomes);
    const conflito = (jaLa || []).filter((w) => !idsMinhas.has(w.id)).map((w) => w.nome);
    if (conflito.length) {
      return res.status(409).json({
        erro: 'nome_duplicado',
        nomes: conflito,
        mensagem: `O grupo atual já tem uma conta chamada "${conflito[0]}". Renomeie uma das duas `
          + 'antes de trazer o banco pra cá.',
      });
    }

    // 4. Move. Carteiras primeiro (é a âncora), conexão por ÚLTIMO — se algo
    //    falhar no meio, o sync continua escrevendo na origem e dá pra repetir.
    const walletIds = [...idsMinhas];
    const contaIds = minhas.map((w) => String(w.of_conta_id));
    const passos = [];
    const mover = async (tabela, coluna, valores) => {
      if (!valores.length) return;
      const { error, count } = await supabase.from(tabela)
        .update({ grupo_id: destino }, { count: 'exact' })
        .eq('grupo_id', origem).in(coluna, valores);
      passos.push({ tabela, movidas: error ? 0 : (count || 0), erro: error ? error.message.slice(0, 80) : null });
    };

    await mover('wallets', 'id', walletIds);
    await mover('transacoes', 'carteira_nome', nomes);
    await mover('recorrencias', 'carteira', nomes);
    for (const t of ['pagamentos_fatura', 'of_faturas', 'of_parcelas_previstas', 'fatura_rollover']) {
      await mover(t, 'cartao_id', walletIds);
    }
    await mover('of_caixinhas', 'of_conta_id', contaIds);

    const { error: eCx } = await supabase.from('of_conexoes')
      .update({ grupo_id: destino }).eq('id', cx.id);
    if (eCx) return res.status(500).json({ erro: `As contas foram movidas, mas a conexão não: ${eCx.message}` });

    res.json({ ok: true, contas: minhas.length, de: origem, para: destino, passos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
