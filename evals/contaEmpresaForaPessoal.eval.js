// =============================================================================
// EVAL — passo B: a conta da empresa sai das finanças PESSOAIS (migration 192).
//
// O que não pode acontecer:
//   · o Pix da empresa continuar contando como receita da pessoa;
//   · desvincular deixar transações "sumidas" do pessoal pra sempre;
//   · passar por cima do "não considerar" que a própria pessoa escolheu;
//   · o sync marcar de novo a transação que a pessoa mandou voltar a contar.
//
// Rodar: npm run eval:conta-empresa-fora-pessoal
// =============================================================================
const { espelharConta, aplicarForaDoPessoal, idsLigadosNaPassada, MARCA_EMPRESA } = require('../src/services/espelhoContaEmpresa');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function criarBanco(inicial, { semColuna = false } = {}) {
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
    // Outra conta (pessoal): nunca é tocada.
    { id: 'tp', grupo_id: 'g1', carteira_nome: 'Nubank', tipo: 'Gasto', valor: 80, data: '2026-10-20', categoria: 'Mercado', observacao: 'MERCADO', pago: true, ignorar_em: null },
  ],
  lancamentos_negocio: [],
  regras_negocio: [],
});
const marca = (b, id) => b.tabelas.transacoes.find((t) => t.id === id).ignorar_em;

(async () => {
  console.log('§1 vincular tira do pessoal o que entra no caixa');
  {
    const b = criarBanco(cenario());
    const r = await espelharConta('cn1', { supabase: b.client });
    eq(r.inseridos, 3, '§1 as três entram no caixa');
    eq(marca(b, 't1'), MARCA_EMPRESA, '§1 o recebimento sai do pessoal');
    eq(marca(b, 't2'), MARCA_EMPRESA, '§1 o pagamento sai do pessoal');
    eq(marca(b, 't3'), 'tudo', '§1 o "não considerar" da pessoa fica como ela escolheu');
    eq(marca(b, 'tp'), null, '§1 a conta pessoal não é tocada');
    eq(r.foraDoPessoal, 2, '§1 conta quantas mudou');
  }
  console.log('  ok');

  console.log('§2 a pessoa manda "voltar a considerar": o próximo sync respeita');
  {
    const b = criarBanco(cenario());
    await espelharConta('cn1', { supabase: b.client });
    b.tabelas.transacoes.find((t) => t.id === 't1').ignorar_em = null;
    await espelharConta('cn1', { supabase: b.client });
    eq(marca(b, 't1'), null, '§2 não marca de novo o que já estava no caixa');
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
    eq(n, 2, '§4 devolve as duas');
    eq([marca(b, 't1'), marca(b, 't2')], [null, null], '§4 voltam a contar no pessoal');
    eq(marca(b, 't3'), 'tudo', '§4 o "não considerar" da pessoa NÃO é desfeito');
    // E religar a opção marca de novo.
    const m = await aplicarForaDoPessoal('cn1', true, { supabase: b.client });
    eq(m, 2, '§4 religar marca de novo');
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

  if (falhas.length) {
    console.error(`\n✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('\n✓ conta da empresa fora do pessoal: todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
