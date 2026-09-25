// =============================================================================
// EVAL — ligar o controle de estoque (relato de cliente, 25/09/2026).
//
// "O controle de estoque não está funcionando na aba Negócios. Não consigo
// deixar salvo a opção de controlar estoque, assim como quando cadastro uma
// compra, a quantidade não está indo automaticamente para o estoque. A
// mensagem de 'Nenhum produto com controle de estoque' está sempre lá."
//
// ⚠️ ERA UM DEFEITO SÓ, COM TRÊS SINTOMAS. `controla_estoque` não estava na
// lista de campos do POST nem do PUT de produtos — o painel sempre mandou, o
// backend sempre descartou. Como `movimentar` começa com
// `if (!produto.controla_estoque) return null`, TUDO a jusante morria junto:
// a compra recebida não dava entrada, a venda não dava baixa, e a aba Estoque
// nunca listava nada. Medido na base: 3 produtos, ZERO com controle, ZERO
// movimentos — a feature nunca funcionou para ninguém.
//
// O que este eval trava:
//   1. O campo GRAVA (POST e PUT) — é a regressão principal.
//   2. Serviço nunca controla estoque (não tem prateleira).
//   3. `eh_servico` efetivo vem do BANCO quando o corpo não o manda.
//   4. Ligar o controle RECONSTRÓI o histórico já lançado (10 − 1 = 9, os
//      números reais do relato).
//   5. A reconstrução é IDEMPOTENTE (ligar/desligar/ligar não duplica).
//   6. Ordem CRONOLÓGICA: compra antes da venda, senão o custo médio sai errado.
//   7. Compra só PEDIDA e venda CANCELADA ficam de fora.
//
// Rodar:  npm run eval:controle-estoque
// =============================================================================
const path = require('path');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

// ── Supabase falso ───────────────────────────────────────────────────────────
function criarBanco(inicial) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;

  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null, embed = null;
    const api = {
      select(cols) {
        // `compra_itens` e `venda_itens` trazem o pai embutido (!inner).
        const m = typeof cols === 'string' && cols.match(/(compras_negocio|vendas_negocio)!inner/);
        if (m) embed = m[1];
        return api;
      },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      order() { return api; },
      limit() { return api; },
      single() { unica = 's'; return api; },
      maybeSingle() { unica = 'm'; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function hidratar(r) {
      if (!embed) return { ...r };
      const chave = embed === 'compras_negocio' ? 'compra_id' : 'venda_id';
      const pai = (tabelas[embed] || []).find((x) => x.id === r[chave]) || null;
      return { ...r, [embed]: pai };
    }
    function exec() {
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') {
        const novas = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: `x${++seq}`, ...p }));
        t.push(...novas);
        return unica ? { data: novas[0], error: null } : { data: novas, error: null };
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      const l = alvo.map(hidratar);
      if (unica === 's') return l.length === 1 ? { data: l[0], error: null } : { data: null, error: { message: 'single' } };
      if (unica === 'm') return { data: l[0] || null, error: null };
      return { data: l, error: null };
    }
    return api;
  }
  return { tabelas, client: { from } };
}

function carregar(banco) {
  const raiz = path.join(__dirname, '..', 'src') + path.sep;
  const fixar = (rel, ex) => { const f = path.join(raiz, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: ex }; };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (q, s, n) => n());
  fixar('services/folha.js', { comissaoDe: () => 0, resumoMensal: async () => ({}) });
  fixar('services/insightsLoja.js', { analisar: async () => [] });
  fixar('services/acessoEmpresa.js', {
    podeNaEmpresa: async () => true, empresasDoUsuario: async () => [], empresaAssumida: () => null,
    papelPermite: () => true, papelNaEmpresa: async () => 'admin', PAPEIS: [],
  });

  const router = require(path.join(raiz, 'routes/negociosOperacao.js'));
  const h = (metodo, rota) => {
    const l = router.stack.find((x) => x.route && x.route.path === rota && x.route.methods[metodo]);
    if (!l) throw new Error(`rota: ${metodo} ${rota}`);
    return l.route.stack[l.route.stack.length - 1].handle;
  };
  const chamar = (metodo, rota) => async (req = {}) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await h(metodo, rota)({ params: {}, query: {}, body: {}, method: metodo.toUpperCase(), authUser: { id: 'u1' }, ...req }, res);
    return res;
  };
  return {
    criarProduto: chamar('post', '/produtos'),
    editarProduto: chamar('put', '/produtos/:id'),
    estoque: chamar('get', '/estoque/:phone'),
    estoqueSvc: require(path.join(raiz, 'services/estoque.js')),
  };
}

// ── Cenário: os números do relato ────────────────────────────────────────────
// Compra recebida em 24/09 de 10x "Ouro Branco" a R$1,00; venda de 1x em 25/09.
function cenario() {
  return {
    users: [{ id: 'u1', grupo_ativo: 'g1', plano: 'premium' }],
    empresas: [{ id: 'e1', user_id: 'u1', grupo_id: 'g1', nome: 'BVendas', tipo: 'fisico', ativa: true }],
    produtos_negocio: [{
      id: 'p1', empresa_id: 'e1', nome: 'Ouro Branco', preco: 200, custo: 100,
      controla_estoque: false, eh_servico: false, estoque_atual: 0, ativo: true, unidade: 'un',
    }],
    compras_negocio: [
      { id: 'co1', empresa_id: 'e1', status: 'recebida', data: '2026-09-24', recebida_em: '2026-09-24' },
      { id: 'co2', empresa_id: 'e1', status: 'pedida',   data: '2026-09-26', recebida_em: null },
    ],
    compra_itens: [
      { id: 'ci1', compra_id: 'co1', produto_id: 'p1', quantidade: 10, custo_unit: 100 },
      { id: 'ci2', compra_id: 'co2', produto_id: 'p1', quantidade: 50, custo_unit: 100 },
    ],
    vendas_negocio: [
      { id: 'v1', empresa_id: 'e1', status: 'concluida', data: '2026-09-25' },
      { id: 'v2', empresa_id: 'e1', status: 'cancelada', data: '2026-09-25' },
    ],
    venda_itens: [
      { id: 'vi1', venda_id: 'v1', produto_id: 'p1', quantidade: 1, custo_unit: 100 },
      { id: 'vi2', venda_id: 'v2', produto_id: 'p1', quantidade: 4, custo_unit: 100 },
    ],
    estoque_movimentos: [],
    lancamentos_negocio: [],
  };
}

const prod = (b, id = 'p1') => b.tabelas.produtos_negocio.find((p) => p.id === id);

(async () => {
  console.log('── 1. o campo GRAVA (era descartado em silêncio) ──');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const novo = await r.criarProduto({ body: { empresa_id: 'e1', nome: 'Bala', preco: 100, controla_estoque: true } });
    eq(novo.statusCode, 200, 'POST responde 200');
    eq(novo.body.produto.controla_estoque, true, '⚠️ POST grava controla_estoque (antes saía sempre false)');

    const ed = await r.editarProduto({ params: { id: 'p1' }, body: { nome: 'Ouro Branco', controla_estoque: true } });
    eq(ed.statusCode, 200, 'PUT responde 200');
    eq(prod(b).controla_estoque, true, '⚠️ PUT grava controla_estoque — é o "não consigo deixar salvo" do relato');
  }
  console.log('  ok');

  console.log('── 2 e 3. serviço nunca controla; eh_servico efetivo vem do banco ──');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const s = await r.criarProduto({ body: { empresa_id: 'e1', nome: 'Corte', preco: 5000, eh_servico: true, controla_estoque: true } });
    eq(s.body.produto.controla_estoque, false, 'serviço não controla estoque nem se pedirem');

    // Produto que JÁ é serviço no banco; o corpo manda só `controla_estoque`.
    b.tabelas.produtos_negocio.push({
      id: 'p2', empresa_id: 'e1', nome: 'Lavagem', preco: 100, custo: 0,
      eh_servico: true, controla_estoque: false, estoque_atual: 0, ativo: true,
    });
    await r.editarProduto({ params: { id: 'p2' }, body: { controla_estoque: true } });
    eq(prod(b, 'p2').controla_estoque, false,
      '⚠️ `eh_servico` EFETIVO sai do banco — ler o do corpo daria undefined e o serviço viraria produto');
  }
  console.log('  ok');

  console.log('── 4. ligar o controle traz o histórico: 10 − 1 = 9 ──');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const ed = await r.editarProduto({ params: { id: 'p1' }, body: { nome: 'Ouro Branco', controla_estoque: true } });
    eq(ed.body.estoque.saldo, 9, '⚠️ saldo reconstruído do que a pessoa JÁ lançou (10 comprados − 1 vendido)');
    eq(ed.body.estoque.movimentos, 2, 'dois movimentos: a compra recebida e a venda');
    eq(prod(b).estoque_atual, 9, 'e o cache do produto acompanha');

    const lista = await r.estoque({ query: { empresa_id: 'e1' } });
    eq(lista.body.produtos.length, 1, '⚠️ a aba Estoque deixa de dizer "Nenhum produto com controle de estoque"');
    eq(lista.body.produtos[0].estoque_atual, 9, 'com o saldo certo');
  }
  console.log('  ok');

  console.log('── 5. idempotente: ligar, desligar e ligar não duplica ──');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    await r.editarProduto({ params: { id: 'p1' }, body: { controla_estoque: true } });
    await r.editarProduto({ params: { id: 'p1' }, body: { controla_estoque: false } });
    const terceiro = await r.editarProduto({ params: { id: 'p1' }, body: { controla_estoque: true } });
    eq(terceiro.body.estoque.movimentos, 0, '⚠️ nenhum movimento novo — a origem já foi contada');
    eq(b.tabelas.estoque_movimentos.length, 2, 'e a prateleira continua com 2 movimentos, não 4');

    // ⚠️ SALVAR COM O CONTROLE JÁ LIGADO NÃO REPROCESSA NADA. A dedup por
    // origem sozinha já impediria a duplicata (é o que a mutação mostrou),
    // mas sem a guarda da transição cada "Salvar" do modal varreria compras e
    // vendas do produto à toa — e o custo do Supabase é o NÚMERO de idas.
    // `estoque: null` é a prova observável de que a reconstrução nem rodou.
    const semMexer = await r.editarProduto({ params: { id: 'p1' }, body: { nome: 'Ouro Branco', controla_estoque: true } });
    eq(semMexer.body.estoque, null, '⚠️ já estava ligado → não relê o histórico (só a TRANSIÇÃO reconstrói)');
  }
  console.log('  ok');

  console.log('── 6. ordem CRONOLÓGICA (o custo médio depende dela) ──');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    await r.editarProduto({ params: { id: 'p1' }, body: { controla_estoque: true } });
    const datas = b.tabelas.estoque_movimentos.map((m) => `${m.data}:${m.tipo}`);
    eq(datas.join(' '), '2026-09-24:entrada 2026-09-25:saida',
      '⚠️ a compra entra ANTES da venda — invertido, a saída sairia de saldo zero e o custo médio quebraria');
    eq(prod(b).custo, 100, 'custo médio preservado');
  }
  console.log('  ok');

  console.log('── 7. compra só PEDIDA e venda CANCELADA ficam de fora ──');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const ed = await r.editarProduto({ params: { id: 'p1' }, body: { controla_estoque: true } });
    // Sem os filtros seria 10 + 50 − 1 − 4 = 55.
    eq(ed.body.estoque.saldo, 9,
      '⚠️ 50 pedidos (não chegaram) e 4 de venda cancelada NÃO entram — senão o saldo sairia 55');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ controle de estoque: todos os casos passaram');
})();
