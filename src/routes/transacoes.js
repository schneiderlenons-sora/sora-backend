const express  = require('express');
const arquivadas = require('../services/arquivadas');
const { ehPagamentoFatura } = require('../services/categorizar');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { calcularResumo, calcularResumoAnual } = require('../services/resumoTransacoes');
// Conta em moeda estrangeira (migration 144). `valor` continua SEMPRE em BRL;
// o nativo e a taxa congelada do dia vão em colunas próprias.
const {
  normalizarMoeda: normalizarMoedaTx,
  taxas: taxasTx,
  camposTransacao,
} = require('../services/moeda');

const norm = p => p?.replace(/\D/g, '');
// Normaliza nome de conta pra comparar (lowercase, sem acento).
const normNome = s => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Primeiro dia do mês seguinte (YYYY-MM-01) — usado como limite exclusivo.
// Evita usar `${mes}-31` que é data inválida em meses de 30/28/29 dias
// (Postgres rejeita e a query falha → fatura aparece vazia).
function proximoMesPrimeiroDia(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m, 1); // m (1-based) vira mês 0-based seguinte
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Identidade pelo usuário AUTENTICADO (JWT/e-mail), não pelo telefone — assim
// quem tem só e-mail (sem WhatsApp) também acessa. O middleware `auth` já
// resolveu o grupo ativo a partir do user.id do login.
function usuarioReq(req) {
  return req.authUser?.grupoAtivo
    ? { id: req.authUser.id, grupo_ativo: req.authUser.grupoAtivo }
    : null;
}

/**
 * Aplica a categoria a TODAS as transações do mesmo estabelecimento e grava a
 * regra pras próximas (migration 104).
 *
 * O casamento usa o mesmo termo normalizado do serviço de regras, então
 * "FernandoPeixoto", "FERNANDO PEIXOTO" e "PIX FERNANDOPEIXOTO 0512" contam
 * como o mesmo lugar. Devolve `{ termo, atualizadas }` pro painel dizer quantas
 * mudaram — sem isso o usuário não sabe se a ação pegou 1 ou 40 lançamentos.
 */
async function aplicarCategoriaNoEstabelecimento({ grupoId, userId, descricao, categoria, ignorarId } = {}) {
  const { salvarRegra, termoDe, normalizar: normRegra } = require('../services/regrasCategoria');
  const termo = await salvarRegra({ grupoId, descricao, categoria, userId });
  if (!termo) return null;

  // Só as que ainda NÃO estão na categoria certa (evita update à toa) e que de
  // fato casam o termo — o filtro fino é em JS, porque o termo já vem sem ruído
  // e o `ilike` do Postgres não normaliza acento.
  const { data: candidatas } = await supabase.from('transacoes')
    .select('id, observacao, categoria').eq('grupo_id', grupoId).neq('categoria', categoria);

  const alvo = normRegra(termo);
  const ids = (candidatas || [])
    .filter((t) => {
      if (ignorarId && t.id === ignorarId) return false;
      const d = normRegra(t.observacao);
      return d && (d === alvo || d.includes(alvo) || alvo.includes(d));
    })
    .map((t) => t.id);

  let atualizadas = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const { error } = await supabase.from('transacoes')
      .update({ categoria }).in('id', lote).eq('grupo_id', grupoId);
    if (!error) atualizadas += lote.length;
  }
  return { termo, atualizadas };
}

// GET /api/transacoes/duplicadas/:phone — o que o Detetive Watson encontrou.
//
// Vem ANTES de `/:phone` só por clareza (a rota tem 2 segmentos, então não
// haveria conflito de qualquer forma). Devolve GRUPOS, não pares: a mesma
// compra pode ter entrado 3 vezes, e mostrar 3 pares faria o usuário apagar
// demais. O primeiro de cada grupo é o mais antigo — o que se deve manter.
// `?cartao=<wallet_id>` recorta pela FATURA ATUAL daquele cartão (ciclo real de
// fechamento, não mês-calendário). Sem ele, últimos `dias`.
//
// Devolve DUAS listas: `grupos` (o que o Watson AFIRMA, com prova) e
// `suspeitas` (o que ele PERGUNTA). Misturar as duas é o que faria o agente
// acusar inocente — ver o cabeçalho de services/duplicadas.js.
router.get('/duplicadas/:phone', auth, async (req, res) => {
  try {
    const user = usuarioReq(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const { buscarAnalise, explicar } = require('../services/duplicadas');
    const { confirmadas, suspeitas, escopo } = await buscarAnalise(user.grupo_ativo, {
      dias: Math.min(365, parseInt(req.query.dias, 10) || 90),
      cartaoId: req.query.cartao || null,
    });
    const vestir = (g) => ({ motivo: g.motivo, explicacao: explicar(g), transacoes: g.transacoes });
    res.json({
      total: confirmadas.length,
      grupos: confirmadas.map(vestir),
      suspeitas: suspeitas.map(vestir),
      escopo,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/transacoes/:phone?mes=2026-05&tipo=Gasto&categoria=Mercado&limit=50&offset=0&criado_por_me=true&criado_por_phone=XX
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = usuarioReq(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const grupoId = user.grupo_ativo;

    const { mes, tipo, categoria, limit = 50, offset = 0, criado_por_me, ate, bill_id } = req.query;

    // ⚠️ "undefined" E "null" CHEGAM COMO STRING. `new URLSearchParams({ x:
    // undefined })` no cliente NÃO pula a chave — ela vira a string literal
    // "undefined", que é truthy aqui e ia direto pro `.eq()`. O Postgres
    // respondia `invalid input syntax for type uuid: "undefined"` e a rota
    // devolvia ZERO transações.
    //
    // Bug real: a aba Relatórios manda `criado_por` vazio quando o filtro de
    // membro está em "todos", que é o PADRÃO — então a aba "Lançamentos
    // pendentes" ficava vazia pra todo mundo (medido: 141 transações do mês
    // viravam 0). O cliente foi corrigido junto, mas esta trava fica: JS velho
    // em cache no navegador de alguém continua mandando o valor antigo.
    const limpo = (v) => (v === 'undefined' || v === 'null' || v === '' ? undefined : v);
    const criado_por = limpo(req.query.criado_por);
    const criado_por_phone = limpo(req.query.criado_por_phone);
    // Aba "Arquivadas" (migration 131): com ?arquivadas=1 devolve SÓ as que EU
    // escondi. Sem o parâmetro, elas ficam de fora de tudo.
    const verArquivadas = req.query.arquivadas === '1' || req.query.arquivadas === 'true';

    // Tenta com JOIN — se a FK não existir no schema, cai para SELECT * sem join
    let query = supabase.from('transacoes')
      .select('*, criador:users!transacoes_criado_por_fkey(id, name, phone, avatar_url, avatar_preset, avatar_cor)', { count: 'exact' })
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    // Fatura do emissor (Open Finance, migration 101): filtro EXCLUSIVO com o
    // mês — a parcela é lançada com a data da COMPRA, então buscá-la por mês
    // não a acharia na fatura em que ela realmente é cobrada.
    if (bill_id)   query = query.eq('of_bill_id', bill_id);
    else if (mes)  query = query.gte("data", `${mes}-01`).lt("data", proximoMesPrimeiroDia(mes));
    if (ate)       query = query.lte('data', ate); // exclui lançamentos futuros (ex.: parcelas)
    if (tipo)      query = query.eq('tipo', tipo);
    if (categoria) query = query.eq('categoria', categoria);

    if (criado_por) {
      query = query.eq('criado_por', criado_por); // filtro por membro (user_id) — escopo do grupo
    } else if (criado_por_me === 'true') {
      query = query.eq('criado_por', user.id);
    } else if (criado_por_phone) {
      const { data: outro } = await supabase.from('users')
        .select('id').eq('phone', norm(criado_por_phone)).maybeSingle();
      if (outro?.id) query = query.eq('criado_por', outro.id);
    }

    query = await arquivadas.filtrar(query, {
      userId: user.id, mostrar: verArquivadas ? 'minhas' : 'nenhuma',
    });

    let { data, count, error } = await query;
    if (error) {
      // Fallback: mantém o criador com colunas seguras (sem preset/cor da
      // migration 048) pra o avatar do autor não sumir. Só cai pro '*' puro
      // se nem isso funcionar (FK ausente).
      console.warn('[transacoes] join fallback:', error.message);
      const baseQ2 = async (embed) => {
        let q = supabase.from('transacoes').select(embed, { count: 'exact' })
          .eq('grupo_id', grupoId)
          .order('data', { ascending: false })
          .range(Number(offset), Number(offset) + Number(limit) - 1);
        if (bill_id)   q = q.eq('of_bill_id', bill_id);
        else if (mes)  q = q.gte("data", `${mes}-01`).lt("data", proximoMesPrimeiroDia(mes));
        if (ate)       q = q.lte('data', ate);
        if (tipo)      q = q.eq('tipo', tipo);
        if (categoria) q = q.eq('categoria', categoria);
        q = await arquivadas.filtrar(q, { userId: user.id, mostrar: verArquivadas ? 'minhas' : 'nenhuma' });
        if (criado_por) q = q.eq('criado_por', criado_por);
        else if (criado_por_me === 'true') q = q.eq('criado_por', user.id);
        return q;
      };
      let r = await baseQ2('*, criador:users!transacoes_criado_por_fkey(id, name, phone, avatar_url)');
      if (r.error) r = await baseQ2('*');
      data = r.data; count = r.count;
    }
    // Alias wallet_nome → o frontend lê esse campo; no banco a coluna é carteira_nome
    const transacoes = (data || []).map(t => ({ ...t, wallet_nome: t.carteira_nome }));
    res.json({ transacoes, total: count || 0 });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transacoes — cria transação pelo painel
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, tipo, categoria, valor, observacao, carteira_nome, data, pago, recorrente,
      transferencia } = req.body;
    const grupoId = req.grupoId;
    const userId  = req.userId;

    // Guardrail anti-conta-fantasma: casa a conta informada com uma wallet REAL
    // do grupo; se não existir, cai em 'Dinheiro' (nunca grava nome inexistente).
    // ⚠️ `select('*')` e NÃO `select('id, saldo, nome, moeda')`: pedir a coluna
    // `moeda` (migration 144) pelo NOME faria esta query falhar enquanto a
    // migration não roda — e ela é o caminho crítico do lançamento. Mesma lição
    // que já derrubou o Grow inteiro ("Usuário não encontrado") e está no
    // CLAUDE.md. Com `*` a coluna vem se existir e some se não existir.
    const { data: wsGrupo } = await supabase.from('wallets').select('*').eq('grupo_id', grupoId);
    const walletReal = (wsGrupo || []).find(w => normNome(w.nome) === normNome(carteira_nome));
    const contaFinal = walletReal ? walletReal.nome : 'Dinheiro';

    // ── Moeda da conta (migration 144) ──────────────────────────────────────
    // O valor digitado está na moeda DA CONTA. `camposTransacao` devolve o BRL
    // congelado pra `valor` — que é o que todo o resto do sistema soma — e
    // guarda o nativo + a taxa do dia ao lado.
    //
    // ⚠️ Em conta BRL devolve `{ valor, moeda:null, valor_moeda:null,
    // taxa_brl:null }`: a linha sai IDÊNTICA à de antes, sem efeito colateral.
    const moedaConta = normalizarMoedaTx(walletReal?.moeda);
    const tabelaTx   = moedaConta === 'BRL' ? {} : await taxasTx([moedaConta]);
    const campoMoeda = camposTransacao(parseFloat(valor), moedaConta, tabelaTx);

    // Data FUTURA (fuso SP)? Um lançamento que ainda NÃO aconteceu não pode
    // entrar como "pago" nem debitar o saldo hoje.
    const hojeSP   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const dataStr  = String(data || '').slice(0, 10);
    const ehFuturo = !!dataStr && dataStr > hojeSP;
    const mDia     = dataStr.match(/^\d{4}-\d{2}-(\d{2})/);
    const diaVenc  = mDia ? parseInt(mDia[1], 10) : new Date().getUTCDate();

    // "Recorrente" com data FUTURA = a pessoa está CADASTRANDO uma conta fixa que
    // ainda vai vencer — não existe gasto hoje. Cria SÓ a recorrência: no dia o
    // cron lança, debita e avisa. (Com data de hoje/passado o gasto já aconteceu:
    // lança agora + cria a recorrência, e o cron deduplica o mês.)
    if (recorrente && ehFuturo) {
      const { criarRecorrencia } = require('../services/recorrencias');
      const rec = await criarRecorrencia({
        grupoId, criadoPor: userId, tipo, categoria, valor,
        dia_vencimento: diaVenc, descricao: observacao, carteira: contaFinal,
        valor_variavel: false,
      });
      return res.json({ ok: true, somente_recorrencia: true, recorrencia: rec });
    }

    const idCurto = Math.random().toString(36).substring(2, 8).toUpperCase();

    const linha = {
      id_curto:      idCurto,
      grupo_id:      grupoId,
      criado_por:    userId,
      tipo,
      categoria,
      valor:         campoMoeda.valor,   // SEMPRE BRL (congelado, ver moeda.js)
      observacao:    observacao || '',
      carteira_nome: contaFinal,
      pago:          ehFuturo ? false : (pago !== false),
      // Estorno/crédito na fatura do cartão: fica FORA de receita e de gasto
      // nos relatórios e ABATE a fatura (services/valorFatura.js). É o que
      // permite lançar um reembolso à mão — antes só o sync do Open Finance
      // conseguia produzir uma linha assim.
      transferencia: transferencia === true,
      data:          data || new Date().toISOString(),
    };
    // Campos de moeda só entram quando NÃO é BRL — assim a linha em real fica
    // byte a byte igual à de antes, e o insert não menciona colunas da 144.
    if (campoMoeda.moeda) {
      linha.moeda       = campoMoeda.moeda;
      linha.valor_moeda = campoMoeda.valor_moeda;
      linha.taxa_brl    = campoMoeda.taxa_brl;
    }

    let { data: tx, error } = await supabase.from('transacoes').insert(linha).select().single();
    // Tolerante à migration 144: sem ela, o lançamento em moeda estrangeira
    // ainda acontece (só sem o registro do câmbio) em vez de falhar.
    if (error && /moeda|valor_moeda|taxa_brl/i.test(error.message || '')) {
      const { moeda: _m, valor_moeda: _vm, taxa_brl: _t, ...semMoeda } = linha;
      ({ data: tx, error } = await supabase.from('transacoes').insert(semMoeda).select().single());
    }

    if (error) throw error;

    // Só debita o que está pago (futuro fica pendente até o dia chegar).
    //
    // ⚠️ O SALDO É DEBITADO NO VALOR NATIVO, não no BRL. Uma conta Nomad guarda
    // dólares: gastar US$ 50 tem de tirar 50 do saldo dela, não os R$ 270 que a
    // transação registra. Confundir os dois zeraria a conta do cliente em
    // poucos lançamentos.
    if (tx.pago && walletReal) {
      const mult = tipo === 'Gasto' ? -1 : 1;
      const valorNativo = campoMoeda.valor_moeda ?? campoMoeda.valor;
      await supabase.from('wallets')
        .update({ saldo: (walletReal.saldo || 0) + (valorNativo * mult) }).eq('id', walletReal.id);
    }

    // Limite de gasto: o alerta só existia pra lançamento vindo do zap — quem
    // usa o painel nunca era avisado, e hoje é por lá (e pelo Open Finance) que
    // entra o volume. Em background: aviso é efeito colateral, não pode atrasar
    // a resposta nem derrubar o lançamento se o WhatsApp falhar.
    if (tx.pago && tipo === 'Gasto') {
      require('../services/limites').verificarLimiteEmBackground(grupoId, phone);
    }

    // Toggle "Recorrente" com data de hoje/passado: o gasto já aconteceu (lançado
    // acima) e ainda vira conta fixa pros próximos meses. O cron deduplica o mês
    // atual (mesma categoria+valor+dia), então não duplica o lançamento de hoje.
    if (recorrente) {
      try {
        const { criarRecorrencia } = require('../services/recorrencias');
        await criarRecorrencia({
          grupoId, criadoPor: userId, tipo, categoria, valor,
          dia_vencimento: diaVenc, descricao: observacao, carteira: contaFinal,
          valor_variavel: false,
        });
      } catch (e) { console.error('[transacoes] recorrência do modal falhou:', e.message); }
    }

    res.json(tx);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transacoes/parcelado — compra parcelada NO CARTÃO DE CRÉDITO.
// Cria N transações (uma por mês), cada uma = valor_parcela. `pagas` = array com
// os números das parcelas já pagas (1..N). O modelo "1 tx por mês" faz o cartão
// mostrar a fatura mês a mês e o limite comprometido (soma das parcelas) sozinho.
router.post('/parcelado', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { categoria, observacao, carteira_nome, valor_parcela, num_parcelas, data, pagas } = req.body;
    const grupoId = req.grupoId, userId = req.userId;

    const n  = parseInt(num_parcelas, 10);
    const vp = parseFloat(valor_parcela);
    if (!Number.isInteger(n) || n < 1 || n > 60) return res.status(400).json({ erro: 'Número de parcelas inválido (1 a 60).' });
    if (!(vp > 0)) return res.status(400).json({ erro: 'Valor da parcela inválido.' });

    // Parcelado é só em CARTÃO DE CRÉDITO.
    const { data: wsGrupo } = await supabase.from('wallets').select('id, nome, tipo, saldo').eq('grupo_id', grupoId);
    const card = (wsGrupo || []).find(w => normNome(w.nome) === normNome(carteira_nome) && w.tipo === 'Crédito');
    if (!card) return res.status(400).json({ erro: 'Compra parcelada só pode ser lançada em um cartão de crédito.' });

    const pagasSet = new Set((Array.isArray(pagas) ? pagas : []).map(Number));
    const grupoParcela = 'P' + Math.random().toString(36).substring(2, 10).toUpperCase();
    // Data da 1ª parcela (meio-dia evita virar o dia por fuso). Parcela i = 1ª + (i-1) meses.
    const base = data ? new Date(`${String(data).slice(0, 10)}T12:00:00`) : new Date();

    const rows = [];
    for (let i = 1; i <= n; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + (i - 1), base.getDate(), 12, 0, 0);
      rows.push({
        id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
        grupo_id:      grupoId,
        criado_por:    userId,
        tipo:          'Gasto',
        categoria:     categoria || '📦 Outros',
        valor:         vp,
        observacao:    (observacao || '').toString().slice(0, 200),
        carteira_nome: card.nome,
        pago:          pagasSet.has(i),
        data:          d.toISOString(),
        parcela_num:   i,
        parcela_total: n,
        parcela_grupo: grupoParcela,
      });
    }

    const { data: inseridas, error } = await supabase.from('transacoes').insert(rows).select('id');
    if (error) throw error;

    // Simetria com o POST single: parcela PAGA desconta o saldo do cartão (as
    // futuras ficam pago=false e não mexem). O DELETE reverte por parcela paga.
    const pagasCount = rows.filter(r => r.pago).length;
    if (pagasCount > 0) {
      await supabase.from('wallets')
        .update({ saldo: (card.saldo || 0) - (vp * pagasCount) }).eq('id', card.id);
    }

    res.json({ ok: true, parcela_grupo: grupoParcela, criadas: inseridas?.length || n });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/transacoes/bulk — importação em massa (OFX/CSV)
router.post('/bulk', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { transacoes } = req.body;
    if (!Array.isArray(transacoes) || transacoes.length === 0) {
      return res.status(400).json({ erro: 'Lista de transações vazia.' });
    }
    if (transacoes.length > 1000) {
      return res.status(400).json({ erro: 'Limite de 1000 transações por importação.' });
    }

    // Dedup por FITID (id único da transação no OFX): descarta o que já existe
    // no grupo. Rede de segurança contra reimportar o mesmo extrato.
    const fitidsEnviados = transacoes.map(t => t.fitid).filter(Boolean);
    let jaExistem = new Set();
    if (fitidsEnviados.length) {
      const { data: existentes } = await supabase.from('transacoes')
        .select('fitid').eq('grupo_id', req.grupoId).in('fitid', fitidsEnviados);
      jaExistem = new Set((existentes || []).map(e => e.fitid));
    }

    // Guardrail anti-conta-fantasma: casa cada carteira_nome com uma wallet REAL
    // do grupo; se não existir, cai em 'Dinheiro'. Evita gravar conta que não
    // existe (cliente antigo/bug), que sumia com o dinheiro em conta nenhuma.
    const { data: walletsGrupo } = await supabase.from('wallets').select('nome').eq('grupo_id', req.grupoId);
    const nomesReais = new Map((walletsGrupo || []).map(w => [normNome(w.nome), w.nome]));
    const reconciliarConta = (cn) => {
      const k = normNome(cn);
      if (!k || k === 'dinheiro') return 'Dinheiro';
      return nomesReais.get(k) || 'Dinheiro';
    };

    const rows = transacoes
      .filter(t => !t.fitid || !jaExistem.has(t.fitid))
      .map(t => ({
        id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
        grupo_id:      req.grupoId,
        criado_por:    req.userId,
        tipo:          t.tipo === 'Recebimento' ? 'Recebimento' : 'Gasto',
        categoria:     t.categoria || '📦 Outros',
        valor:         Math.abs(parseFloat(t.valor) || 0),
        observacao:    (t.observacao || '').toString().slice(0, 200),
        carteira_nome: reconciliarConta(t.carteira_nome),
        pago:          t.pago !== false,
        data:          t.data,
        fitid:         t.fitid || null,
      }));

    const duplicados = transacoes.length - rows.length;
    if (rows.length === 0) return res.json({ inserted: 0, duplicados });

    // Regra do usuário manda sobre o motor de palavras (migration 104): quem já
    // corrigiu "FernandoPeixoto" não vai ver o extrato novo cair em "Outros".
    try {
      const { aplicarRegrasEmLote } = require('../services/regrasCategoria');
      await aplicarRegrasEmLote(req.grupoId, rows);
    } catch { /* migration 104 pendente */ }

    // Não mexe no saldo: o extrato do banco já reflete essas transações; o
    // saldo da conta é informado/ajustado separadamente pelo usuário.
    const { data, error } = await supabase.from('transacoes').insert(rows).select('id');
    if (error) throw error;

    // Importar extrato costuma ser o que ESTOURA o limite do mês. Uma chamada
    // só depois do lote (a dedup do serviço garante um aviso por limite por mês).
    if (rows.some((r) => r.tipo === 'Gasto' && r.pago)) {
      require('../services/limites').verificarLimiteEmBackground(req.grupoId, null);
    }

    res.json({ inserted: data?.length || 0, duplicados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/transacoes/:id — edita (update PARCIAL: só os campos enviados)
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { tipo, categoria, valor, observacao, carteira_nome, data, pago } = req.body;
    const patch = {};
    if (tipo !== undefined)          patch.tipo = tipo;
    if (categoria !== undefined)     patch.categoria = categoria;
    if (valor !== undefined)         patch.valor = parseFloat(valor);
    if (observacao !== undefined)    patch.observacao = observacao;
    if (carteira_nome !== undefined) patch.carteira_nome = carteira_nome;
    if (data !== undefined)          patch.data = data;
    if (pago !== undefined)          patch.pago = pago;

    // Estado ANTES (pra reconciliar o saldo da carteira pela diferença).
    const { data: antes } = await supabase.from('transacoes')
      .select('*').eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();

    // Só edita transação do próprio grupo (anti-IDOR)
    const { data: tx, error } = await supabase.from('transacoes')
      .update(patch).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    if (error) throw error;

    // Reconcilia o saldo da carteira: efeito = pago ? (Gasto −valor / Receita +valor) : 0.
    // Aplica a DIFERENÇA (depois − antes) — cobre marcar pendente→pago (ex.: confirmar
    // um "previsto" variável), mudar o valor de um pago, ou trocar de conta. Pula
    // transferências e fatura de cartão (têm débito próprio) pra não contar em dobro.
    try {
      const especial = (t) => !t || t.transferencia === true || ehPagamentoFatura(t.categoria) || t.categoria === 'Transferências';
      if (!especial(antes) && !especial(tx)) {
        const efeito = (t) => (t.pago ? (t.tipo === 'Gasto' ? -1 : 1) * (Number(t.valor) || 0) : 0);
        const ajustar = async (nome, delta) => {
          if (!delta || !nome) return;
          const { data: w } = await supabase.from('wallets')
            .select('id, saldo').eq('grupo_id', req.grupoId).ilike('nome', nome).maybeSingle();
          if (w) await supabase.from('wallets').update({ saldo: (w.saldo || 0) + delta }).eq('id', w.id);
        };
        if (normNome(antes.carteira_nome) === normNome(tx.carteira_nome)) {
          await ajustar(tx.carteira_nome, efeito(tx) - efeito(antes));
        } else {
          await ajustar(antes.carteira_nome, -efeito(antes)); // tira o efeito da conta antiga
          await ajustar(tx.carteira_nome, efeito(tx));         // aplica na conta nova
        }
      }
    } catch (e) { console.warn('[transacoes PUT] reconcilia saldo falhou:', e.message); }

    // "Vale pra todas": a correção do usuário vira REGRA do estabelecimento
    // (migration 104) e é aplicada nas transações que já existem. Assim ele
    // corrige "FernandoPeixoto" uma vez, não todo mês. Best-effort: falhar aqui
    // não pode desfazer a edição que já foi salva.
    let regra = null;
    if (req.body?.aplicar_todas && categoria !== undefined && tx) {
      try {
        regra = await aplicarCategoriaNoEstabelecimento({
          grupoId: req.grupoId, userId: req.userId,
          descricao: tx.observacao, categoria, ignorarId: tx.id,
        });
      } catch (e) { console.warn('[transacoes PUT] regra de categoria falhou:', e.message); }
    }

    res.json({ ...tx, regra });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/transacoes/antecipar-cartao — paga parcelas do cartão debitando
// de uma conta bancária. Pagar fatura é uma transferência (conta → cartão):
// marca as parcelas como pagas (libera limite) e debita o saldo da conta,
// sem criar gasto novo (não duplica nos relatórios).
router.post('/antecipar-cartao', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { ids, conta_nome } = req.body;
    const grupoId = req.grupoId;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ erro: 'Nenhuma parcela informada.' });
    }
    if (!conta_nome) return res.status(400).json({ erro: 'Conta de pagamento não informada.' });

    // Soma só das parcelas em aberto (evita debitar o que já estava pago)
    const { data: parcelas } = await supabase.from('transacoes')
      .select('id, valor, pago').eq('grupo_id', grupoId).in('id', ids);
    const emAberto = (parcelas || []).filter(p => p.pago === false);
    if (emAberto.length === 0) return res.json({ ok: true, debitado: 0 });
    const total = emAberto.reduce((s, p) => s + (p.valor || 0), 0);

    // Marca como pagas
    await supabase.from('transacoes').update({ pago: true })
      .in('id', emAberto.map(p => p.id));

    // Debita o saldo da conta escolhida
    const { data: conta } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', conta_nome).maybeSingle();
    if (conta) {
      await supabase.from('wallets')
        .update({ saldo: (conta.saldo || 0) - total }).eq('id', conta.id);
    }

    res.json({ ok: true, debitado: total, conta: conta_nome });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/transacoes/:id
// PATCH /:id/arquivar — esconde (ou mostra de novo) uma transação.
//
// ⚠️ NÃO É EXCLUSÃO. A linha continua no banco, com valor e data — o que
// muda é só a VISÃO. Em conta de Open Finance apagar seria pior que inútil:
// o próximo sync traria a transação de volta, porque a dedup é por
// `of_tx_id` e a linha teria sumido.
//
// ⚠️ QUEM ARQUIVA É QUEM VÊ. Guardamos o `user_id` porque a aba
// "Arquivadas" é pessoal: some pros dois, reaparece só pra quem escondeu.
router.patch('/:id/arquivar', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const arquivar = req.body?.arquivar !== false;   // default: arquivar
    const { data: tx } = await supabase.from('transacoes')
      .select('id, arquivada_por').eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();
    if (!tx) return res.status(404).json({ erro: 'Transação não encontrada.' });

    // ⚠️ Só quem arquivou desarquiva. Sem isto, o parceiro não veria a
    // transação mas poderia trazê-la de volta chutando o id.
    if (!arquivar && tx.arquivada_por && tx.arquivada_por !== req.userId) {
      return res.status(403).json({ erro: 'Quem arquivou foi outra pessoa.' });
    }

    const { error } = await supabase.from('transacoes').update({
      arquivada_por: arquivar ? req.userId : null,
      arquivada_em: arquivar ? new Date().toISOString() : null,
    }).eq('id', req.params.id).eq('grupo_id', req.grupoId);

    if (error) {
      // Coluna ausente = migration 131 pendente. Diz isso em vez de um erro cru.
      if (/arquivada_por|column/i.test(error.message)) {
        return res.status(503).json({ erro: 'Recurso ainda não liberado no banco (migration 131).' });
      }
      return res.status(500).json({ erro: error.message });
    }
    res.json({ ok: true, arquivada: arquivar });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    // Só a transação do próprio grupo (anti-IDOR)
    const { data: tx } = await supabase.from('transacoes')
      .select('*').eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();
    if (!tx) return res.status(404).json({ erro: 'Transação não encontrada' });

    // Excluir a COMPRA PARCELADA inteira? (?parcelas=todas) — apaga todas as
    // parcelas do mesmo parcela_grupo. Senão, só a parcela/transação clicada.
    const excluirTodas = req.query.parcelas === 'todas' && tx.parcela_grupo;
    let alvos = [tx];
    if (excluirTodas) {
      const { data: grupo } = await supabase.from('transacoes')
        .select('*').eq('grupo_id', req.grupoId).eq('parcela_grupo', tx.parcela_grupo);
      if (grupo?.length) alvos = grupo;
    }

    // Reverte o saldo de cada alvo PAGO (por carteira).
    for (const t of alvos) {
      if (!t.pago) continue;
      const mult = t.tipo === 'Gasto' ? 1 : -1;
      const { data: wallet } = await supabase.from('wallets')
        .select('id, saldo').eq('grupo_id', t.grupo_id).ilike('nome', t.carteira_nome).maybeSingle();
      if (wallet) {
        await supabase.from('wallets')
          .update({ saldo: (wallet.saldo || 0) + (t.valor * mult) }).eq('id', wallet.id);
      }
    }

    // ⚠️ Transação vinda do Open Finance: registrar que foi APAGADA (migration
    // 113). O sync deduplica por `of_tx_id` olhando a tabela `transacoes` — sem
    // este registro a linha apagada não é encontrada e o sync seguinte a
    // reimporta como se fosse nova. Ou seja, excluir não adiantava nada: no dia
    // seguinte a transação estava de volta.
    // Tolerante: sem a migration, a exclusão acontece como antes.
    const doOF = alvos.filter((t) => t.of_tx_id).map((t) => ({
      grupo_id: req.grupoId, of_tx_id: t.of_tx_id, motivo: 'excluida pelo usuario',
    }));
    if (doOF.length) {
      try {
        await supabase.from('of_tx_ignoradas').upsert(doOF, { onConflict: 'grupo_id,of_tx_id' });
      } catch { /* migration 113 pendente */ }
    }

    if (excluirTodas) {
      await supabase.from('transacoes').delete().eq('grupo_id', req.grupoId).eq('parcela_grupo', tx.parcela_grupo);
    } else {
      await supabase.from('transacoes').delete().eq('id', req.params.id).eq('grupo_id', req.grupoId);
    }
    res.json({ ok: true, excluidas: alvos.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/transacoes/:phone/resumo?mes=2026-05&criado_por_me=true
router.get('/:phone/resumo', auth, async (req, res) => {
  try {
    const user = usuarioReq(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    // Fonte única (services/resumoTransacoes) — mesma regra do dashboard.
    const resumo = await calcularResumo({
      grupoId: user.grupo_ativo, mes,
      // criado_por (user_id) filtra por membro; criado_por_me = o próprio user.
      // Escopo é sempre o grupo do user (calcularResumo filtra por grupo_ativo).
      criadoPorId: req.query.criado_por || (req.query.criado_por_me === 'true' ? user.id : undefined),
    });
    res.json(resumo);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/transacoes/:phone/anual?ano=2026&criado_por=<id>
//
// Os 12 meses do ano, com a MESMA regra do resumo mensal (fonte única em
// services/resumoTransacoes). Existe porque a aba Fluxo de caixa desenhava os
// 12 meses a partir de uma SENOIDE sobre o valor do mês atual — número
// inventado numa tela de dinheiro.
router.get('/:phone/anual', auth, async (req, res) => {
  try {
    const user = usuarioReq(req);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
    const dados = await calcularResumoAnual({
      grupoId: user.grupo_ativo, ano,
      criadoPorId: req.query.criado_por || (req.query.criado_por_me === 'true' ? user.id : undefined),
    });
    res.json(dados);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
