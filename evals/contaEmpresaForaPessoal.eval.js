// =============================================================================
// EVAL — passo B: a conta da empresa sai das finanças PESSOAIS (migration 192).
//
// O que não pode acontecer:
//   · o Pix da empresa continuar contando como receita da pessoa;
//   · desvincular deixar transações "sumidas" do pessoal pra sempre;
//   · passar por cima do "não considerar" que a própria pessoa escolheu;
//   · sobrar transação da conta da empresa no pessoal: a regra vale pra CONTA
//     INTEIRA (nov/2026), inclusive os meses antes do vínculo e a cópia que o
//     agregador reprocessa com id novo;
//   · tocar em transação de OUTRA carteira ou de OUTRO grupo;
//   · o SALDO de uma conta da empresa somar como dinheiro da pessoa — e, se a
//     leitura falhar, esconder o saldo dela (degrada pro lado de mostrar).
//
// Rodar: npm run eval:conta-empresa-fora-pessoal
// =============================================================================
const { espelharConta, aplicarForaDoPessoal, idsLigadosNaPassada, MARCA_EMPRESA } = require('../src/services/espelhoContaEmpresa');
const { carteirasDaEmpresa, marcarDaEmpresa, doPessoal, ehDaEmpresa } = require('../src/services/contaDaEmpresa');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function criarBanco(inicial, { semColuna = false, falhar = null } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null, cols = '';
    const api = {
      select(c) { if (modo === 'select') cols = c || ''; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      not(c, op, v) { filtros.push((r) => (r[c] ?? null) !== v); return api; },
      in(c, vs) { filtros.push((r) => vs.includes(r[c])); return api; },
      gte(c, v) { filtros.push((r) => r[c] != null && String(r[c]) >= String(v)); return api; },
      order() { return api; },
      range(a, b) { api._range = [a, b]; return api; },
      maybeSingle() { unica = 'm'; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
      if (falhar === nome) return { data: null, error: { message: 'falha simulada' } };
      if (semColuna && nome === 'contas_negocio' && /fora_do_pessoal/.test(cols)) {
        return { data: null, error: { message: 'column contas_negocio.fora_do_pessoal does not exist' } };
      }
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') {
        const novas = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: `n${++seq}`, ...p }));
        t.push(...novas); return { data: novas, error: null };
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      let l = alvo.map((r) => ({ ...r }));
      if (api._range) l = l.slice(api._range[0], api._range[1] + 1);
      return unica === 'm' ? { data: l[0] || null, error: null } : { data: l, error: null };
    }
    return api;
  }
  return { tabelas, client: { from } };
}

const cenario = (extraConta = {}) => ({
  contas_negocio: [{ id: 'cn1', empresa_id: 'e1', user_id: 'u1', wallet_id: 'w1', importar_desde: '2026-10-01', ativa: true, fora_do_pessoal: true, ...extraConta }],
  wallets: [{ id: 'w1', grupo_id: 'g1', nome: 'Mercado Pago PJ', tipo: 'Corrente', moeda: 'BRL', of_conta_id: 'of1' }],
  transacoes: [
    { id: 't1', grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ', tipo: 'Recebimento', valor: 1500, data: '2026-10-20', categoria: 'Pix', observacao: 'PIX RECEBIDO CLIENTE', pago: true, ignorar_em: null },
    { id: 't2', grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ', tipo: 'Gasto', valor: 300, data: '2026-10-21', categoria: 'Outros', observacao: 'BOLETO FORNECEDOR', pago: true, ignorar_em: null },
    // A própria pessoa já tinha mandado não considerar esta (regra dela).
    { id: 't3', grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ', tipo: 'Gasto', valor: 50, data: '2026-10-22', categoria: 'Outros', observacao: 'TARIFA', pago: true, ignorar_em: 'tudo' },
    // SETEMBRO: antes do vínculo, nunca entra no caixa — e é da empresa também.
    { id: 't0', grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ', tipo: 'Recebimento', valor: 700, data: '2026-09-15', categoria: 'Pix', observacao: 'PIX SETEMBRO', pago: true, ignorar_em: null },
    // Mesmo NOME de carteira em OUTRO grupo: nunca é tocada.
    { id: 'tg', grupo_id: 'g2', carteira_nome: 'Mercado Pago PJ', tipo: 'Gasto', valor: 60, data: '2026-10-20', categoria: 'Outros', observacao: 'OUTRO GRUPO', pago: true, ignorar_em: null },
    // Outra conta (pessoal): nunca é tocada.
    { id: 'tp', grupo_id: 'g1', carteira_nome: 'Nubank', tipo: 'Gasto', valor: 80, data: '2026-10-20', categoria: 'Mercado', observacao: 'MERCADO', pago: true, ignorar_em: null },
  ],
  lancamentos_negocio: [],
  regras_negocio: [],
});
const marca = (b, id) => b.tabelas.transacoes.find((t) => t.id === id).ignorar_em;

(async () => {
  console.log('§1 vincular tira do pessoal a conta inteira');
  {
    const b = criarBanco(cenario());
    const r = await espelharConta('cn1', { supabase: b.client });
    eq(r.inseridos, 3, '§1 as três entram no caixa');
    eq(marca(b, 't1'), MARCA_EMPRESA, '§1 o recebimento sai do pessoal');
    eq(marca(b, 't2'), MARCA_EMPRESA, '§1 o pagamento sai do pessoal');
    eq(marca(b, 't3'), 'tudo', '§1 o "não considerar" da pessoa fica como ela escolheu');
    eq(marca(b, 't0'), MARCA_EMPRESA, '§1 setembro (antes do vínculo, fora do caixa) também sai');
    eq(marca(b, 'tp'), null, '§1 a conta pessoal não é tocada');
    eq(marca(b, 'tg'), null, '§1 o mesmo nome em outro grupo não é tocado');
    eq(r.foraDoPessoal, 3, '§1 conta quantas mudou');
    eq(b.tabelas.lancamentos_negocio.some((l) => l.transacao_id === 't0'), false, '§1 setembro NÃO entra no caixa (o caixa começa no vínculo)');
  }
  console.log('  ok');

  console.log('§2 a conta inteira continua fora a cada passada');
  {
    const b = criarBanco(cenario());
    await espelharConta('cn1', { supabase: b.client });
    // A marca some (edição à mão, ou a cópia que o agregador reprocessa com id
    // novo nasce sem ela): a conta é da empresa, a próxima passada recoloca.
    b.tabelas.transacoes.find((t) => t.id === 't1').ignorar_em = null;
    b.tabelas.transacoes.push({ id: 't0b', grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ', tipo: 'Recebimento', valor: 700, data: '2026-09-15', categoria: 'Pix', observacao: 'PIX SETEMBRO', pago: true, ignorar_em: null });
    await espelharConta('cn1', { supabase: b.client });
    eq(marca(b, 't1'), MARCA_EMPRESA, '§2 a transação da conta da empresa volta a sair do pessoal');
    eq(marca(b, 't0b'), MARCA_EMPRESA, '§2 a cópia reprocessada de setembro sai também');
    eq(marca(b, 't3'), 'tudo', '§2 sem passar por cima do "não considerar" dela');
    // Transação NOVA do banco: entra marcada.
    b.tabelas.transacoes.push({ id: 't4', grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ', tipo: 'Recebimento', valor: 900, data: '2026-10-25', categoria: 'Pix', observacao: 'PIX', pago: true, ignorar_em: null });
    await espelharConta('cn1', { supabase: b.client });
    eq(marca(b, 't4'), MARCA_EMPRESA, '§2 a nova entra marcada');
  }
  console.log('  ok');

  console.log('§3 conta mista (opção desligada) e sem a migration');
  {
    const mista = criarBanco(cenario({ fora_do_pessoal: false }));
    await espelharConta('cn1', { supabase: mista.client });
    eq([marca(mista, 't1'), marca(mista, 't2')], [null, null], '§3 conta mista continua no pessoal');

    const sem = criarBanco(cenario(), { semColuna: true });
    const r = await espelharConta('cn1', { supabase: sem.client });
    eq(r.inseridos, 3, '§3 sem a 192 o espelho segue funcionando');
    eq([marca(sem, 't1'), marca(sem, 't2')], [null, null], '§3 e nada sai do pessoal');
  }
  console.log('  ok');

  console.log('§4 desvincular devolve exatamente o que foi tirado');
  {
    const b = criarBanco(cenario());
    await espelharConta('cn1', { supabase: b.client });
    const n = await aplicarForaDoPessoal('cn1', false, { supabase: b.client });
    eq(n, 3, '§4 devolve as três');
    eq([marca(b, 't0'), marca(b, 't1'), marca(b, 't2')], [null, null, null], '§4 voltam a contar no pessoal (setembro inclusive)');
    eq(marca(b, 't3'), 'tudo', '§4 o "não considerar" da pessoa NÃO é desfeito');
    // E religar a opção marca de novo.
    const m = await aplicarForaDoPessoal('cn1', true, { supabase: b.client });
    eq(m, 3, '§4 religar marca de novo (a conta inteira)');
    eq(marca(b, 'tg'), null, '§4 outro grupo segue intacto');
    eq(marca(b, 't3'), 'tudo', '§4 sem passar por cima da escolha dela');
  }
  console.log('  ok');

  console.log('§5 quais transações a passada liga');
  {
    eq(idsLigadosNaPassada({ inserir: [{ transacao_id: 'a' }, { transacao_id: 'b' }], juntar: [{ transacaoId: 'c' }, { transacaoId: 'a' }] }).sort(),
      ['a', 'b', 'c'], '§5 inseridas + juntadas, sem repetir');
    eq(idsLigadosNaPassada({ inserir: [], juntar: [] }), [], '§5 nada ligado, nada marcado');
  }
  console.log('  ok');

  console.log('§6 o SALDO: quais carteiras são da empresa');
  {
    const base = () => ({
      contas_negocio: [
        { id: 'cn1', empresa_id: 'e1', wallet_id: 'w1', ativa: true, fora_do_pessoal: true },
        { id: 'cn2', empresa_id: 'e1', wallet_id: 'w2', ativa: true, fora_do_pessoal: false },  // conta mista
        { id: 'cn3', empresa_id: 'e1', wallet_id: 'w3', ativa: false, fora_do_pessoal: true },  // conta apagada
        { id: 'cn4', empresa_id: 'e1', wallet_id: null, ativa: true, fora_do_pessoal: true },   // sem banco
      ],
      empresas: [{ id: 'e1', nome: 'Vida Mais' }],
    });
    const ws = [{ id: 'w1', nome: 'MP PJ' }, { id: 'w2', nome: 'Mista' }, { id: 'w3', nome: 'Antiga' }, { id: 'w9', nome: 'Nubank' }];
    const b = criarBanco(base());
    const m = await carteirasDaEmpresa(ws.map((w) => w.id), { supabase: b.client });
    eq([...m.keys()], ['w1'], '§6 só a conta ligada, ativa e "só da empresa"');
    eq(m.get('w1'), { conta_id: 'cn1', empresa_id: 'e1', empresa_nome: 'Vida Mais' }, '§6 diz de qual empresa');
    const marcadas = await marcarDaEmpresa(ws, { supabase: b.client });
    eq(marcadas.map((w) => ehDaEmpresa(w)), [true, false, false, false], '§6 marca só a da empresa');
    eq(doPessoal(marcadas).map((w) => w.id), ['w2', 'w3', 'w9'], '§6 o saldo pessoal fica com as outras');

    // ⚠️ Falha de leitura DEVOLVE A CONTA PRO SALDO, nunca a esconde.
    const f = criarBanco(base(), { falhar: 'contas_negocio' });
    eq(doPessoal(await marcarDaEmpresa(ws, { supabase: f.client })).length, 4, '§6 leitura que falha não esconde dinheiro');
    // Sem a 192 a coluna não existe: nada é da empresa (como era antes).
    const sem = criarBanco(base(), { semColuna: true });
    eq((await carteirasDaEmpresa(['w1'], { supabase: sem.client })).size, 0, '§6 sem a 192, nada sai do saldo');
    // Nome da empresa que falha não derruba a marca.
    const semNome = criarBanco(base(), { falhar: 'empresas' });
    eq((await carteirasDaEmpresa(['w1'], { supabase: semNome.client })).get('w1')?.conta_id, 'cn1', '§6 sem o nome da empresa a marca fica');
    eq((await carteirasDaEmpresa([], { supabase: b.client })).size, 0, '§6 lista vazia não consulta nada');
  }
  console.log('  ok');

  if (falhas.length) {
    console.error(`\n✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('\n✓ conta da empresa fora do pessoal: todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
