// =============================================================================
// Sora Negócios — OPERAÇÃO: clientes, produtos e vendas (fase 2, migration 106).
//
// Arquivo próprio porque `routes/negocios.js` já passa de 1.600 linhas. Monta
// no MESMO prefixo (/api/negocios), então pro cliente é tudo uma coisa só.
//
// A regra que amarra tudo: VENDA GERA LANÇAMENTO NO CAIXA. Não existe "caixa de
// vendas" paralelo — à vista nasce lançamento pago, a prazo nasce pendente (que
// é a conta a receber). É a mesma escolha da folha e das contas a pagar, e é o
// que faz o DRE e os indicadores enxergarem a venda sem nenhuma ponte.
// =============================================================================
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { comissaoDe, resumoMensal } = require('../services/folha');
const { analisar: analisarLoja } = require('../services/insightsLoja');

async function getUser(req) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo, plano').eq('id', req.authUser?.id || '__none__').maybeSingle();
  return data;
}
const temAcesso = (u) => u?.plano === 'premium' || u?.plano === 'platinum';

/** Empresa do usuário (anti-IDOR: sempre valida a posse). */
async function empresaDoUsuario(userId, empresaId) {
  if (!empresaId) return null;
  const { data } = await supabase.from('empresas')
    .select('id').eq('id', empresaId).eq('user_id', userId).maybeSingle();
  return data || null;
}

/** Guarda comum: autenticado + plano + empresa dele. */
async function contexto(req, res, empresaIdBruto) {
  const user = await getUser(req);
  if (!user?.grupo_ativo) { res.status(404).json({ erro: 'Usuário não encontrado.' }); return null; }
  if (!temAcesso(user))   { res.status(403).json({ erro: 'Recurso do plano Premium.' }); return null; }
  const empresa = await empresaDoUsuario(user.id, empresaIdBruto);
  if (!empresa)           { res.status(404).json({ erro: 'Empresa não encontrada.' }); return null; }
  return { user, empresa };
}

/** Erro de tabela ausente (migration 106 pendente) → resposta clara, não 500. */
const semMigration = (error, tabela) =>
  new RegExp(tabela, 'i').test(error?.message || '') && /does not exist|schema cache/i.test(error?.message || '');

const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const cent   = (v) => Math.round(Number(v) || 0);
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// =============================================================================
// CLIENTES
// =============================================================================
router.get('/clientes/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;

    let q = supabase.from('clientes_negocio')
      .select('*').eq('empresa_id', ctx.empresa.id).eq('ativo', true);

    // Busca do balcão: o vendedor digita 2 letras e espera a lista na hora.
    const busca = String(req.query.q || '').trim();
    if (busca) q = q.or(`nome.ilike.%${busca}%,telefone.ilike.%${busca}%`);

    const { data, error } = await q.order('nome', { ascending: true }).limit(300);
    if (error) return semMigration(error, 'clientes_negocio') ? res.json([]) : res.status(500).json({ erro: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Ficha do cliente: cadastro + o que ele já comprou. É o que responde
// "quanto esse cliente vale" — sem isso a lista de clientes é só uma agenda.
router.get('/clientes/:phone/:id', auth, async (req, res) => {
  try {
    const { data: cli } = await supabase.from('clientes_negocio')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const ctx = await contexto(req, res, cli.empresa_id);
    if (!ctx) return;

    const { data: vendas } = await supabase.from('vendas_negocio')
      .select('id, data, total, custo_total, status, forma_pagamento')
      .eq('cliente_id', cli.id).neq('status', 'cancelada')
      .order('data', { ascending: false }).limit(50);

    const lista = vendas || [];
    const totalGasto  = lista.reduce((s, v) => s + (v.total || 0), 0);
    const lucroGerado = lista.reduce((s, v) => s + ((v.total || 0) - (v.custo_total || 0)), 0);

    res.json({
      ...cli,
      resumo: {
        compras: lista.length,
        total_gasto: totalGasto,
        lucro_gerado: lucroGerado,
        ticket_medio: lista.length ? Math.round(totalGasto / lista.length) : 0,
        ultima_compra: lista[0]?.data || null,
        em_aberto: lista.filter((v) => v.status === 'pendente').reduce((s, v) => s + (v.total || 0), 0),
      },
      vendas: lista,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/clientes', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await contexto(req, res, b.empresa_id);
    if (!ctx) return;
    const nome = String(b.nome || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Informe o nome do cliente.' });

    const { data, error } = await supabase.from('clientes_negocio').insert({
      empresa_id: ctx.empresa.id,
      nome,
      telefone:  soDigitos(b.telefone) || null,
      email:     String(b.email || '').trim() || null,
      documento: String(b.documento || '').trim() || null,
      endereco:  String(b.endereco || '').trim() || null,
      observacao: String(b.observacao || '').trim() || null,
    }).select().single();
    if (error) {
      if (semMigration(error, 'clientes_negocio')) return res.status(503).json({ erro: 'Recurso ainda não liberado no banco (migration 106).' });
      throw error;
    }
    res.json({ ok: true, cliente: data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/clientes/:id', auth, async (req, res) => {
  try {
    const { data: cli } = await supabase.from('clientes_negocio')
      .select('id, empresa_id').eq('id', req.params.id).maybeSingle();
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const ctx = await contexto(req, res, cli.empresa_id);
    if (!ctx) return;

    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.nome       !== undefined) patch.nome       = String(b.nome).trim();
    if (b.telefone   !== undefined) patch.telefone   = soDigitos(b.telefone) || null;
    if (b.email      !== undefined) patch.email      = String(b.email).trim() || null;
    if (b.documento  !== undefined) patch.documento  = String(b.documento).trim() || null;
    if (b.endereco   !== undefined) patch.endereco   = String(b.endereco).trim() || null;
    if (b.observacao !== undefined) patch.observacao = String(b.observacao).trim() || null;

    const { data, error } = await supabase.from('clientes_negocio')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, cliente: data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Arquiva: as vendas dele continuam com o vínculo e o histórico não muda.
router.delete('/clientes/:id', auth, async (req, res) => {
  try {
    const { data: cli } = await supabase.from('clientes_negocio')
      .select('id, empresa_id').eq('id', req.params.id).maybeSingle();
    if (!cli) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const ctx = await contexto(req, res, cli.empresa_id);
    if (!ctx) return;
    await supabase.from('clientes_negocio').update({ ativo: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// =============================================================================
// PRODUTOS E SERVIÇOS
// =============================================================================
router.get('/produtos/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;

    let q = supabase.from('produtos_negocio')
      .select('*').eq('empresa_id', ctx.empresa.id).eq('ativo', true);

    const busca = String(req.query.q || '').trim();
    // Scanner de código de barras: busca exata primeiro (1 hit, sem ambiguidade).
    if (req.query.codigo) q = q.eq('codigo_barras', String(req.query.codigo).trim());
    else if (busca) q = q.or(`nome.ilike.%${busca}%,sku.ilike.%${busca}%`);

    const { data, error } = await q.order('nome', { ascending: true }).limit(500);
    if (error) return semMigration(error, 'produtos_negocio') ? res.json([]) : res.status(500).json({ erro: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function validarProduto(b) {
  if (!String(b.nome || '').trim()) return 'Informe o nome do produto.';
  if (b.preco !== undefined && Number(b.preco) < 0) return 'O preço não pode ser negativo.';
  if (b.custo !== undefined && Number(b.custo) < 0) return 'O custo não pode ser negativo.';
  if (b.foto_url && String(b.foto_url).length > 700000) return 'A foto é muito grande (máx. ~500 KB).';
  return null;
}

router.post('/produtos', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await contexto(req, res, b.empresa_id);
    if (!ctx) return;
    const erroValid = validarProduto(b);
    if (erroValid) return res.status(400).json({ erro: erroValid });

    const { data, error } = await supabase.from('produtos_negocio').insert({
      empresa_id: ctx.empresa.id,
      nome: String(b.nome).trim(),
      sku: String(b.sku || '').trim() || null,
      codigo_barras: String(b.codigo_barras || '').trim() || null,
      categoria: String(b.categoria || '').trim() || null,
      preco: cent(b.preco), custo: cent(b.custo),
      unidade: String(b.unidade || 'un').trim(),
      eh_servico: !!b.eh_servico,
      estoque_min: b.estoque_min == null ? null : cent(b.estoque_min),
      foto_url: b.foto_url || null,
    }).select().single();
    if (error) {
      if (/uq_produtos_sku/.test(error.message || '')) {
        return res.status(409).json({ erro: 'Já existe um produto com esse SKU.' });
      }
      if (semMigration(error, 'produtos_negocio')) return res.status(503).json({ erro: 'Recurso ainda não liberado no banco (migration 106).' });
      throw error;
    }
    res.json({ ok: true, produto: data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/produtos/:id', auth, async (req, res) => {
  try {
    const { data: p } = await supabase.from('produtos_negocio')
      .select('id, empresa_id').eq('id', req.params.id).maybeSingle();
    if (!p) return res.status(404).json({ erro: 'Produto não encontrado.' });
    const ctx = await contexto(req, res, p.empresa_id);
    if (!ctx) return;
    const b = req.body || {};
    const erroValid = validarProduto({ nome: b.nome ?? 'x', ...b });
    if (erroValid) return res.status(400).json({ erro: erroValid });

    const patch = { updated_at: new Date().toISOString() };
    for (const campo of ['nome', 'sku', 'codigo_barras', 'categoria', 'unidade']) {
      if (b[campo] !== undefined) patch[campo] = String(b[campo]).trim() || null;
    }
    if (b.preco       !== undefined) patch.preco = cent(b.preco);
    if (b.custo       !== undefined) patch.custo = cent(b.custo);
    if (b.eh_servico  !== undefined) patch.eh_servico = !!b.eh_servico;
    if (b.estoque_min !== undefined) patch.estoque_min = b.estoque_min == null ? null : cent(b.estoque_min);
    if (b.foto_url    !== undefined) patch.foto_url = b.foto_url || null;

    const { data, error } = await supabase.from('produtos_negocio')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) {
      if (/uq_produtos_sku/.test(error.message || '')) return res.status(409).json({ erro: 'Já existe um produto com esse SKU.' });
      throw error;
    }
    res.json({ ok: true, produto: data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Arquiva: item já vendido não pode sumir (a venda antiga ficaria órfã).
router.delete('/produtos/:id', auth, async (req, res) => {
  try {
    const { data: p } = await supabase.from('produtos_negocio')
      .select('id, empresa_id').eq('id', req.params.id).maybeSingle();
    if (!p) return res.status(404).json({ erro: 'Produto não encontrado.' });
    const ctx = await contexto(req, res, p.empresa_id);
    if (!ctx) return;
    await supabase.from('produtos_negocio').update({ ativo: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// =============================================================================
// VENDAS
// =============================================================================
router.get('/vendas/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;

    let q = supabase.from('vendas_negocio')
      .select('*, itens:venda_itens(*), cliente:clientes_negocio(id, nome, telefone)')
      .eq('empresa_id', ctx.empresa.id);

    if (req.query.mes && /^\d{4}-\d{2}$/.test(req.query.mes)) {
      const [a, m] = req.query.mes.split('-').map(Number);
      const prox = new Date(Date.UTC(a, m, 1));
      q = q.gte('data', `${req.query.mes}-01`)
           .lt('data', `${prox.getUTCFullYear()}-${String(prox.getUTCMonth() + 1).padStart(2, '0')}-01`);
    }
    if (req.query.cliente_id) q = q.eq('cliente_id', req.query.cliente_id);
    if (req.query.status)     q = q.eq('status', req.query.status);

    const { data, error } = await q.order('data', { ascending: false }).limit(300);
    if (error) return semMigration(error, 'vendas_negocio') ? res.json([]) : res.status(500).json({ erro: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/**
 * POST /api/negocios/vendas — registra a venda E o dinheiro dela.
 *
 * O item chega com `produto_id` OU só com nome+preço (venda avulsa do balcão,
 * sem cadastro). Preço e custo são CONGELADOS no item: se o produto mudar de
 * preço amanhã, a margem desta venda continua a mesma — senão o histórico de
 * lucro se reescreveria sozinho a cada alteração de tabela de preço.
 */
router.post('/vendas', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await contexto(req, res, b.empresa_id);
    if (!ctx) return;

    const itensBrutos = Array.isArray(b.itens) ? b.itens : [];
    if (!itensBrutos.length) return res.status(400).json({ erro: 'Adicione pelo menos um item à venda.' });

    // Busca os produtos citados de uma vez (preço/custo/nome atuais).
    const ids = [...new Set(itensBrutos.map((i) => i.produto_id).filter(Boolean))];
    let produtos = [];
    if (ids.length) {
      const { data } = await supabase.from('produtos_negocio')
        .select('id, nome, preco, custo').in('id', ids).eq('empresa_id', ctx.empresa.id);
      produtos = data || [];
    }

    const itens = itensBrutos.map((i) => {
      const p = produtos.find((x) => x.id === i.produto_id);
      const qtd   = Number(i.quantidade) > 0 ? Number(i.quantidade) : 1;
      // Preço informado manda (permite desconto na hora); senão, o do cadastro.
      const preco = i.preco_unit != null ? cent(i.preco_unit) : cent(p?.preco);
      const custo = i.custo_unit != null ? cent(i.custo_unit) : cent(p?.custo);
      const nome  = String(i.nome || p?.nome || 'Item').trim();
      return {
        produto_id: p?.id || null,
        nome, quantidade: qtd,
        preco_unit: preco, custo_unit: custo,
        subtotal: Math.round(preco * qtd),
      };
    });

    const bruto    = itens.reduce((s, i) => s + i.subtotal, 0);
    const desconto = cent(b.desconto);
    const total    = Math.max(0, bruto - desconto);
    const custoTot = itens.reduce((s, i) => s + Math.round(i.custo_unit * i.quantidade), 0);

    const aPrazo = b.status === 'pendente';
    const data   = /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : hojeSP();

    // Comissão do vendedor — CONGELADA aqui, pelo mesmo motivo que preço e
    // custo congelam: mudar o percentual dele amanhã não pode reescrever
    // quanto ele ganhou hoje.
    let comissao = 0;
    if (b.vendedor_id) {
      const { data: vend } = await supabase.from('funcionarios_negocio')
        .select('comissao_pct').eq('id', b.vendedor_id).maybeSingle();
      comissao = comissaoDe(total, vend?.comissao_pct);
    }

    // 1. A venda
    const { data: venda, error: errVenda } = await supabase.from('vendas_negocio').insert({
      empresa_id: ctx.empresa.id,
      cliente_id: b.cliente_id || null,
      cliente_nome: String(b.cliente_nome || '').trim() || null,
      data, total, desconto, custo_total: custoTot,
      forma_pagamento: b.forma_pagamento || null,
      status: aPrazo ? 'pendente' : 'pago',
      vencimento: aPrazo ? (b.vencimento || data) : null,
      observacao: String(b.observacao || '').trim() || null,
      vendedor_id: b.vendedor_id || null,
      conta_id: b.conta_id || null,
      ...(comissao > 0 ? { comissao_valor: comissao } : {}),
    }).select().single();
    if (errVenda) {
      if (semMigration(errVenda, 'vendas_negocio')) return res.status(503).json({ erro: 'Recurso ainda não liberado no banco (migration 106).' });
      throw errVenda;
    }

    // 2. Os itens
    const { error: errItens } = await supabase.from('venda_itens')
      .insert(itens.map((i) => ({ ...i, venda_id: venda.id })));
    if (errItens) {
      // Venda sem item é lixo — desfaz pra não deixar registro pela metade.
      await supabase.from('vendas_negocio').delete().eq('id', venda.id);
      throw errItens;
    }

    // 3. O DINHEIRO: a venda vira lançamento no caixa. À vista = pago;
    //    a prazo = pendente, que é exatamente a conta a receber.
    const descricao = b.descricao
      || (itens.length === 1 ? itens[0].nome : `Venda (${itens.length} itens)`);
    const { data: lanc } = await supabase.from('lancamentos_negocio').insert({
      empresa_id: ctx.empresa.id,
      user_id: ctx.user.id,
      tipo: 'entrada',
      categoria: 'vendas',
      descricao,
      valor: total,
      data,
      status: aPrazo ? 'pendente' : 'pago',
      vencimento: aPrazo ? (b.vencimento || data) : null,
      pago_em: aPrazo ? null : data,
      forma_pagamento: b.forma_pagamento || null,
      contraparte: String(b.cliente_nome || '').trim() || null,
      conta_id: b.conta_id || null,
      venda_id: venda.id,
    }).select('id').single();

    if (lanc?.id) {
      await supabase.from('vendas_negocio').update({ lancamento_id: lanc.id }).eq('id', venda.id);
    }

    // 4. ESTOQUE: baixa o que saiu da prateleira (migration 107). Best-effort
    //    por item — produto sem controle de estoque, serviço ou item avulso são
    //    ignorados, e uma falha aqui NÃO derruba a venda: o dinheiro já entrou,
    //    e saldo se acerta depois.
    let estoque = [];
    try {
      const { baixarVenda } = require('../services/estoque');
      estoque = await baixarVenda({
        empresaId: ctx.empresa.id, vendaId: venda.id,
        itens: itens.map((i, n) => ({ ...i, produto_id: itensBrutos[n]?.produto_id || i.produto_id })),
        data,
      });
    } catch { /* migration 107 pendente → segue sem estoque */ }

    res.json({ ok: true, venda: { ...venda, lancamento_id: lanc?.id || null, itens }, estoque });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/**
 * Cancela a venda. Não apaga: `status='cancelada'` preserva o histórico (o
 * dono precisa saber que houve e foi desfeita). O lançamento no caixa, esse
 * sim, é removido — senão o faturamento do mês continuaria contando dinheiro
 * que não entrou.
 */
router.delete('/vendas/:id', auth, async (req, res) => {
  try {
    const { data: v } = await supabase.from('vendas_negocio')
      .select('id, empresa_id, lancamento_id').eq('id', req.params.id).maybeSingle();
    if (!v) return res.status(404).json({ erro: 'Venda não encontrada.' });
    const ctx = await contexto(req, res, v.empresa_id);
    if (!ctx) return;

    if (v.lancamento_id) await supabase.from('lancamentos_negocio').delete().eq('id', v.lancamento_id);

    // Devolve à prateleira o que tinha saído. Sem isto, cancelar venda faria o
    // estoque encolher pra sempre — e o saldo mentir sem ninguém perceber.
    try {
      const { estornarVenda } = require('../services/estoque');
      await estornarVenda({ empresaId: ctx.empresa.id, vendaId: v.id });
    } catch { /* migration 107 pendente */ }

    await supabase.from('vendas_negocio')
      .update({ status: 'cancelada', lancamento_id: null }).eq('id', v.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// =============================================================================
// ESTOQUE (migration 107)
// =============================================================================

/**
 * GET /estoque/:phone — a visão que responde "onde está meu dinheiro parado".
 * Traz saldo, alerta de reposição, valor imobilizado, parados e mais vendidos.
 */
router.get('/estoque/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;

    const { data: produtos, error } = await supabase.from('produtos_negocio')
      .select('id, nome, sku, unidade, preco, custo, estoque_atual, estoque_min, controla_estoque, eh_servico, foto_url')
      .eq('empresa_id', ctx.empresa.id).eq('ativo', true)
      .order('nome', { ascending: true });
    if (error) return semMigration(error, 'estoque_atual') ? res.json({ produtos: [], resumo: null }) : res.status(500).json({ erro: error.message });

    const controlados = (produtos || []).filter((p) => p.controla_estoque && !p.eh_servico);

    // Movimentos recentes: dão "última entrada/saída" e o que está PARADO.
    const { data: movs } = await supabase.from('estoque_movimentos')
      .select('produto_id, tipo, quantidade, data')
      .eq('empresa_id', ctx.empresa.id)
      .order('data', { ascending: false }).limit(2000);

    const ultimo = new Map();   // produto → { entrada, saida }
    const vendido90 = new Map();
    const limite90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    for (const m of movs || []) {
      const acc = ultimo.get(m.produto_id) || { entrada: null, saida: null };
      if (m.tipo === 'entrada' && !acc.entrada) acc.entrada = m.data;
      if (m.tipo === 'saida'   && !acc.saida)   acc.saida = m.data;
      ultimo.set(m.produto_id, acc);
      if (m.tipo === 'saida' && m.data >= limite90) {
        vendido90.set(m.produto_id, (vendido90.get(m.produto_id) || 0) + Number(m.quantidade));
      }
    }

    const lista = controlados.map((p) => {
      const saldo = Number(p.estoque_atual) || 0;
      const min   = p.estoque_min == null ? null : Number(p.estoque_min);
      const u = ultimo.get(p.id) || {};
      return {
        ...p,
        estoque_atual: saldo,
        valor_estoque: Math.round(saldo * (Number(p.custo) || 0)),
        // Status em três níveis: o dono precisa distinguir "acabou" de "vai
        // acabar" — a ação é diferente (repor hoje × entrar no próximo pedido).
        status: saldo <= 0 ? 'zerado' : (min != null && saldo <= min ? 'baixo' : 'ok'),
        ultima_entrada: u.entrada || null,
        ultima_saida: u.saida || null,
        vendido_90d: vendido90.get(p.id) || 0,
        parado: saldo > 0 && !vendido90.get(p.id),
      };
    });

    res.json({
      produtos: lista,
      resumo: {
        itens: lista.length,
        valor_total: lista.reduce((s, p) => s + p.valor_estoque, 0),
        zerados: lista.filter((p) => p.status === 'zerado').length,
        baixos:  lista.filter((p) => p.status === 'baixo').length,
        parados: lista.filter((p) => p.parado).length,
        // Dinheiro preso em item que não gira há 90 dias — o número que mais
        // dói e que nenhuma planilha mostra sozinha.
        valor_parado: lista.filter((p) => p.parado).reduce((s, p) => s + p.valor_estoque, 0),
        sem_controle: (produtos || []).filter((p) => !p.controla_estoque && !p.eh_servico).length,
      },
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** POST /estoque/ajuste — acerto manual (contagem, perda, quebra). */
router.post('/estoque/ajuste', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await contexto(req, res, b.empresa_id);
    if (!ctx) return;
    if (!b.produto_id || !b.quantidade) return res.status(400).json({ erro: 'Informe o produto e a quantidade.' });

    const { movimentar } = require('../services/estoque');
    const r = await movimentar({
      empresaId: ctx.empresa.id, produtoId: b.produto_id,
      tipo: b.tipo === 'saida' ? 'saida' : 'entrada',
      motivo: ['perda', 'devolucao', 'ajuste'].includes(b.motivo) ? b.motivo : 'ajuste',
      quantidade: b.quantidade, custoUnit: b.custo_unit || 0,
      observacao: b.observacao || null,
    });
    if (!r) return res.status(400).json({ erro: 'Este produto não controla estoque.' });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// =============================================================================
// FORNECEDORES
// =============================================================================
router.get('/fornecedores/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;
    const { data, error } = await supabase.from('fornecedores_negocio')
      .select('*').eq('empresa_id', ctx.empresa.id).eq('ativo', true)
      .order('nome', { ascending: true });
    if (error) return semMigration(error, 'fornecedores_negocio') ? res.json([]) : res.status(500).json({ erro: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/fornecedores', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await contexto(req, res, b.empresa_id);
    if (!ctx) return;
    if (!String(b.nome || '').trim()) return res.status(400).json({ erro: 'Informe o nome do fornecedor.' });
    const { data, error } = await supabase.from('fornecedores_negocio').insert({
      empresa_id: ctx.empresa.id,
      nome: String(b.nome).trim(),
      telefone: soDigitos(b.telefone) || null,
      email: String(b.email || '').trim() || null,
      documento: String(b.documento || '').trim() || null,
      observacao: String(b.observacao || '').trim() || null,
    }).select().single();
    if (error) {
      if (semMigration(error, 'fornecedores_negocio')) return res.status(503).json({ erro: 'Recurso ainda não liberado no banco (migration 107).' });
      throw error;
    }
    res.json({ ok: true, fornecedor: data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/fornecedores/:id', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('fornecedores_negocio')
      .select('id, empresa_id').eq('id', req.params.id).maybeSingle();
    if (!f) return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
    const ctx = await contexto(req, res, f.empresa_id);
    if (!ctx) return;
    await supabase.from('fornecedores_negocio').update({ ativo: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// =============================================================================
// COMPRAS — pedido ao fornecedor. Dá ENTRADA no estoque e gera CONTA A PAGAR.
// =============================================================================
router.get('/compras/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;
    const { data, error } = await supabase.from('compras_negocio')
      .select('*, itens:compra_itens(*), fornecedor:fornecedores_negocio(id, nome)')
      .eq('empresa_id', ctx.empresa.id)
      .order('data', { ascending: false }).limit(200);
    if (error) return semMigration(error, 'compras_negocio') ? res.json([]) : res.status(500).json({ erro: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/compras', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await contexto(req, res, b.empresa_id);
    if (!ctx) return;
    const itensBrutos = Array.isArray(b.itens) ? b.itens : [];
    if (!itensBrutos.length) return res.status(400).json({ erro: 'Adicione pelo menos um item à compra.' });

    const itens = itensBrutos.map((i) => {
      const q = Number(i.quantidade) > 0 ? Number(i.quantidade) : 1;
      const custo = cent(i.custo_unit);
      return {
        produto_id: i.produto_id || null,
        nome: String(i.nome || 'Item').trim(),
        quantidade: q, custo_unit: custo,
        subtotal: Math.round(custo * q),
      };
    });
    const total = itens.reduce((s, i) => s + i.subtotal, 0);
    const data  = /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : hojeSP();
    // "Pedida" = ainda não chegou: não entra no estoque nem vira dívida agora.
    const recebida = b.status !== 'pedida';
    const aPrazo   = !!b.a_prazo;

    const { data: compra, error } = await supabase.from('compras_negocio').insert({
      empresa_id: ctx.empresa.id,
      fornecedor_id: b.fornecedor_id || null,
      fornecedor_nome: String(b.fornecedor_nome || '').trim() || null,
      data, total,
      status: recebida ? 'recebida' : 'pedida',
      recebida_em: recebida ? data : null,
      vencimento: aPrazo ? (b.vencimento || data) : null,
      observacao: String(b.observacao || '').trim() || null,
    }).select().single();
    if (error) {
      if (semMigration(error, 'compras_negocio')) return res.status(503).json({ erro: 'Recurso ainda não liberado no banco (migration 107).' });
      throw error;
    }

    const { error: errItens } = await supabase.from('compra_itens')
      .insert(itens.map((i) => ({ ...i, compra_id: compra.id })));
    if (errItens) {
      await supabase.from('compras_negocio').delete().eq('id', compra.id);
      throw errItens;
    }

    // Conta a pagar (mesma ponte da venda→recebível).
    const { data: lanc } = await supabase.from('lancamentos_negocio').insert({
      empresa_id: ctx.empresa.id, user_id: ctx.user.id,
      tipo: 'saida', categoria: 'fornecedor',
      descricao: b.descricao || `Compra${b.fornecedor_nome ? ` — ${b.fornecedor_nome}` : ''}`,
      valor: total, data,
      status: aPrazo ? 'pendente' : 'pago',
      vencimento: aPrazo ? (b.vencimento || data) : null,
      pago_em: aPrazo ? null : data,
      contraparte: String(b.fornecedor_nome || '').trim() || null,
      conta_id: b.conta_id || null,
      compra_id: compra.id,
    }).select('id').single();

    if (lanc?.id) await supabase.from('compras_negocio').update({ lancamento_id: lanc.id }).eq('id', compra.id);

    // Só mercadoria RECEBIDA entra no estoque — o que foi só pedido ainda não
    // está na prateleira e não pode aparecer como disponível pra vender.
    let estoque = [];
    if (recebida) {
      try {
        const { entrarCompra } = require('../services/estoque');
        estoque = await entrarCompra({ empresaId: ctx.empresa.id, compraId: compra.id, itens, data });
      } catch { /* segue sem estoque */ }
    }

    res.json({ ok: true, compra: { ...compra, lancamento_id: lanc?.id || null, itens }, estoque });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Marca como recebida: é AQUI que a mercadoria pedida entra no estoque. */
router.post('/compras/:id/receber', auth, async (req, res) => {
  try {
    const { data: c } = await supabase.from('compras_negocio')
      .select('*, itens:compra_itens(*)').eq('id', req.params.id).maybeSingle();
    if (!c) return res.status(404).json({ erro: 'Compra não encontrada.' });
    const ctx = await contexto(req, res, c.empresa_id);
    if (!ctx) return;
    if (c.status === 'recebida') return res.json({ ok: true, jaRecebida: true });

    const data = hojeSP();
    await supabase.from('compras_negocio')
      .update({ status: 'recebida', recebida_em: data }).eq('id', c.id);

    let estoque = [];
    try {
      const { entrarCompra } = require('../services/estoque');
      estoque = await entrarCompra({ empresaId: ctx.empresa.id, compraId: c.id, itens: c.itens || [], data });
    } catch { /* segue */ }

    res.json({ ok: true, estoque });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// EQUIPE — o custo real de quem trabalha com você (fase 5, migration 109)
// ═══════════════════════════════════════════════════════════════════

// GET /api/negocios/equipe/:phone?empresa_id=&mes=YYYY-MM
//
// Devolve, por pessoa: salário, comissão APURADA e ainda devida, encargos
// estimados e se o salário do mês já saiu. Uma chamada só — a tela de equipe
// fazia N requisições pra montar isso.
router.get('/equipe/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;

    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : hojeSP().slice(0, 7);
    const ini = `${mes}-01`;
    const fimD = new Date(ini); fimD.setMonth(fimD.getMonth() + 1);
    const fim = fimD.toISOString().slice(0, 10);

    const { data: funcs } = await supabase.from('funcionarios_negocio')
      .select('*').eq('empresa_id', ctx.empresa.id).eq('ativo', true)
      .order('nome');
    const lista = funcs || [];

    // Comissões: as ABERTAS (nunca pagas, de qualquer mês — dívida é dívida) e
    // as apuradas no mês, pra mostrar o desempenho do período.
    let vendas = [];
    try {
      const { data } = await supabase.from('vendas_negocio')
        .select('vendedor_id, comissao_valor, comissao_paga_em, data, total, status')
        .eq('empresa_id', ctx.empresa.id)
        .neq('status', 'cancelada')
        .gt('comissao_valor', 0);
      vendas = data || [];
    } catch { /* sem a 109 ainda → sem comissão */ }

    // Salário já pago no mês (lançamento de folha vinculado à pessoa).
    const { data: pagos } = await supabase.from('lancamentos_negocio')
      .select('funcionario_id, valor, descricao')
      .eq('empresa_id', ctx.empresa.id).eq('categoria', 'folha')
      .gte('data', ini).lt('data', fim);

    const inss = !!(req.query.inss_patronal === '1');

    const equipe = lista.map(f => {
      const minhas = vendas.filter(v => v.vendedor_id === f.id);
      const comissao_aberta = minhas.filter(v => !v.comissao_paga_em)
        .reduce((s, v) => s + (v.comissao_valor || 0), 0);
      const comissao_mes = minhas.filter(v => v.data >= ini && v.data < fim)
        .reduce((s, v) => s + (v.comissao_valor || 0), 0);
      const vendas_mes = minhas.filter(v => v.data >= ini && v.data < fim).length;
      const pagoMes = (pagos || []).filter(p => p.funcionario_id === f.id)
        .reduce((s, p) => s + (p.valor || 0), 0);

      const r = resumoMensal(f, comissao_aberta, inss);
      return {
        ...f,
        ...r,
        // ⚠️ `f.encargos` é o BOOLEANO (o toggle) e `r.encargos` é o VALOR.
        // O spread acima faz o número vencer — a tela precisa dos dois, e sem
        // este par o formulário de edição perderia o estado do toggle.
        encargos:       !!f.encargos,
        encargos_valor: r.encargos,
        comissao_aberta, comissao_mes, vendas_mes,
        pago_no_mes: pagoMes,
        // "Já pagou o salário deste mês?" — a pergunta que a lista responde.
        salario_pago: pagoMes >= (f.salario || 0) && (f.salario || 0) > 0,
      };
    });

    res.json({
      mes,
      equipe,
      folha_salarios: equipe.reduce((s, f) => s + (f.salario || 0), 0),
      comissoes_abertas: equipe.reduce((s, f) => s + f.comissao_aberta, 0),
      encargos_estimados: equipe.reduce((s, f) => s + (f.encargos_valor || 0), 0),
      custo_total: equipe.reduce((s, f) => s + f.custo_total, 0),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/negocios/funcionarios/:id/pagar-comissao
// Paga TUDO que está aberto pra essa pessoa e marca as vendas. Marcar é o que
// impede pagar a mesma comissão duas vezes — sem isso, a lista continuaria
// mostrando a dívida e o dono pagaria de novo no mês seguinte.
router.post('/funcionarios/:id/pagar-comissao', auth, async (req, res) => {
  try {
    const { data: f } = await supabase.from('funcionarios_negocio')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (!f) return res.status(404).json({ erro: 'Funcionário não encontrado.' });
    const ctx = await contexto(req, res, f.empresa_id);
    if (!ctx) return;

    const { data: abertas } = await supabase.from('vendas_negocio')
      .select('id, comissao_valor')
      .eq('empresa_id', f.empresa_id).eq('vendedor_id', f.id)
      .neq('status', 'cancelada')
      .gt('comissao_valor', 0).is('comissao_paga_em', null);

    const total = (abertas || []).reduce((s, v) => s + (v.comissao_valor || 0), 0);
    if (total <= 0) return res.json({ ok: true, nada: true });

    const data = hojeSP();
    const { data: lanc, error } = await supabase.from('lancamentos_negocio').insert({
      empresa_id: f.empresa_id,
      user_id: ctx.user.id,
      tipo: 'saida', categoria: 'folha',
      descricao: `Comissão — ${f.nome}`,
      valor: total, data, status: 'pago', pago_em: data,
      forma_pagamento: req.body?.forma_pagamento || 'pix',
      contraparte: f.nome, funcionario_id: f.id,
    }).select().single();
    if (error) throw error;

    await supabase.from('vendas_negocio')
      .update({ comissao_paga_em: data })
      .in('id', (abertas || []).map(v => v.id));

    res.json({ ok: true, total, lancamento: lanc });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// INSIGHTS DE LOJA (fase 6) — o que a Sora percebe olhando o negócio
// ═══════════════════════════════════════════════════════════════════

// GET /api/negocios/insights-loja/:phone?empresa_id=
//
// Calculado AO VIVO, não em cron. Insight guardado de ontem sobre estoque que
// já foi reposto é pior que nenhum insight — o dono perde a confiança na tela.
// São 5 queries pequenas por empresa; não vale materializar.
router.get('/insights-loja/:phone', auth, async (req, res) => {
  try {
    const ctx = await contexto(req, res, req.query.empresa_id);
    if (!ctx) return;
    const empId = ctx.empresa.id;
    const hoje  = hojeSP();
    const ini   = `${hoje.slice(0, 7)}-01`;

    // Produtos + a última venda de cada um (pra saber o que encalhou).
    let produtos = [];
    try {
      const { data } = await supabase.from('produtos_negocio')
        .select('id, nome, preco, custo, estoque_atual, estoque_min, eh_servico')
        .eq('empresa_id', empId).eq('ativo', true);
      produtos = data || [];
    } catch { /* sem a 106 */ }

    if (produtos.length) {
      // Uma query pra todos: a última saída por produto. Buscar item a item
      // seria N requisições pra montar uma tela.
      const { data: movs } = await supabase.from('estoque_movimentos')
        .select('produto_id, data, tipo')
        .eq('empresa_id', empId).eq('tipo', 'saida')
        .order('data', { ascending: false }).limit(1000);
      const ultima = {};
      for (const m of movs || []) if (!ultima[m.produto_id]) ultima[m.produto_id] = m.data;
      produtos = produtos.map(p => ({ ...p, ultima_venda: ultima[p.id] || null }));
    }

    // Clientes: quantas compras e a última.
    let clientes = [];
    try {
      const { data: vendas } = await supabase.from('vendas_negocio')
        .select('cliente_id, data').eq('empresa_id', empId)
        .neq('status', 'cancelada').not('cliente_id', 'is', null);
      const porCliente = {};
      for (const v of vendas || []) {
        const c = porCliente[v.cliente_id] || { compras: 0, ultima_compra: null };
        c.compras += 1;
        if (!c.ultima_compra || v.data > c.ultima_compra) c.ultima_compra = v.data;
        porCliente[v.cliente_id] = c;
      }
      const ids = Object.keys(porCliente);
      if (ids.length) {
        const { data: nomes } = await supabase.from('clientes_negocio')
          .select('id, nome').in('id', ids);
        clientes = (nomes || []).map(n => ({ ...n, ...porCliente[n.id] }));
      }
    } catch { /* sem a 106 */ }

    // Pendências dos dois lados do caixa.
    const { data: pendentes } = await supabase.from('lancamentos_negocio')
      .select('tipo, valor, vencimento, descricao')
      .eq('empresa_id', empId).eq('status', 'pendente');
    const receber = (pendentes || []).filter(l => l.tipo === 'entrada');
    const pagar   = (pendentes || []).filter(l => l.tipo === 'saida');

    // DRE do mês: reaproveita o snapshot se existir (evita 4 queries a mais).
    const { data: dre } = await supabase.from('dre_snapshots')
      .select('*').eq('empresa_id', empId).eq('periodo', ini).maybeSingle();

    const insights = analisarLoja({ dre, produtos, clientes, receber, pagar, hoje });
    res.json({ insights, gerado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
