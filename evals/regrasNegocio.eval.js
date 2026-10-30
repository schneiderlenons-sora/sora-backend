// =============================================================================
// EVAL do "aprende" do caixa da empresa (services/regrasNegocio.js + espelho).
//
// O risco não é deixar de aprender: é aprender ERRADO e classificar o mês
// inteiro numa categoria só ("PIX RECEBIDO" vira regra e pega todo Pix), ou
// passar por cima de uma categoria que a pessoa escolheu.
//
// Rodar: npm run eval:regras-negocio
// =============================================================================
const path = require('path');

// Banco falso em memória — o regrasCategoria exige o cliente ao carregar.
function criarBanco(inicial, { semTabela = false } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null;
    const api = {
      select() { return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      in(c, vs) { filtros.push((r) => vs.includes(r[c])); return api; },
      maybeSingle() { unica = 'm'; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
      if (semTabela && nome === 'regras_negocio') return { data: null, error: { message: 'relation "regras_negocio" does not exist' } };
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') { t.push({ id: `r${++seq}`, ...payload }); return { data: null, error: null }; }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      const l = alvo.map((r) => ({ ...r }));
      return unica === 'm' ? { data: l[0] || null, error: null } : { data: l, error: null };
    }
    return api;
  }
  return { tabelas, client: { from } };
}
const raiz = path.join(__dirname, '..', 'src') + path.sep;
const dbFalso = criarBanco({});
require.cache[path.join(raiz, 'db/supabase.js')] = { id: 'x', filename: 'x', loaded: true, exports: dbFalso.client };

const { termoAprendivel, categoriaPorRegra, aprender } = require('../src/services/regrasNegocio');
const { planejarEspelho } = require('../src/services/espelhoContaEmpresa');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

(async () => {
  console.log('§1 o que pode virar regra');
  {
    eq(termoAprendivel('PIX RECEBIDO'), null, '§1 Pix sem nome não vira regra');
    eq(termoAprendivel('PAGAMENTO 123456'), null, '§1 só código não vira regra');
    eq(termoAprendivel('Tarifa'), null, '§1 tarifa sozinha não vira regra');
    eq(termoAprendivel('PIX ENVIADO GOL'), null, '§1 nome de 3 letras é pouco');
    eq(termoAprendivel('Pix recebido JOAO DA SILVA 0512'), 'joao silva', '§1 sobra o nome');
    eq(termoAprendivel('TED ENVIADA ACME LTDA'), 'acme', '§1 ruído de banco sai do termo');
    eq(termoAprendivel('PIX ENVIADO ACME'), 'acme', '§1 TED e Pix do mesmo fornecedor viram o MESMO termo');
  }
  console.log('  ok');

  console.log('§2 qual regra vale');
  {
    const regras = [
      { termo: 'joao silva', tipo: 'entrada', categoria: 'servico' },
      { termo: 'acme', tipo: 'saida', categoria: 'fornecedor' },
      { termo: 'acme filial', tipo: 'saida', categoria: 'filial' },
      { termo: 'aluguel', tipo: null, categoria: 'aluguel' },
    ];
    eq(categoriaPorRegra(regras, { descricao: 'PIX RECEBIDO JOAO DA SILVA', tipo: 'entrada' }), 'servico', '§2 casa com "de" no meio');
    eq(categoriaPorRegra(regras, { descricao: 'PIX ENVIADO JOAO DA SILVA', tipo: 'saida' }), null, '§2 regra de entrada não vale pra saída');
    eq(categoriaPorRegra(regras, { descricao: 'TED ACME FILIAL SP', tipo: 'saida' }), 'filial', '§2 a mais específica vence');
    eq(categoriaPorRegra(regras, { descricao: 'BOLETO ACME', tipo: 'saida' }), 'fornecedor', '§2 a geral quando a específica não casa');
    eq(categoriaPorRegra(regras, { descricao: 'ALUGUEL SALA', tipo: 'entrada' }), 'aluguel', '§2 regra sem sentido vale pros dois');
    eq(categoriaPorRegra(regras, { descricao: 'PIX RECEBIDO MARIA', tipo: 'entrada' }), null, '§2 outro nome: nada');
    eq(categoriaPorRegra([], { descricao: 'qualquer', tipo: 'entrada' }), null, '§2 sem regras: nada');
  }
  console.log('  ok');

  console.log('§3 o espelho usa as regras ao trazer do banco');
  {
    const tx = (id, tipo, obs, extra = {}) => ({ id, tipo, valor: 150, data: '2026-10-20', observacao: obs, categoria: 'Pix', ...extra });
    const plano = planejarEspelho({
      transacoes: [
        tx('t1', 'Recebimento', 'PIX RECEBIDO JOAO DA SILVA'),
        tx('t2', 'Recebimento', 'PIX RECEBIDO MARIA SOUZA'),
        tx('t3', 'Recebimento', 'PIX RECEBIDO JOAO DA SILVA', { transferencia: true }),
      ],
      lancamentos: [], desde: '2026-10-01', contaId: 'c1', empresaId: 'e1', userId: 'u1',
      regras: [{ termo: 'joao silva', tipo: 'entrada', categoria: 'servico' }],
    });
    const cat = Object.fromEntries(plano.inserir.map((l) => [l.transacao_id, l.categoria]));
    eq(cat.t1, 'servico', '§3 o que casa já entra classificado');
    eq(cat.t2, 'a_classificar', '§3 o resto entra neutro');
    eq(cat.t3, 'movimentacao', '§3 movimentação entre contas vence a regra');
  }
  console.log('  ok');

  console.log('§4 aprender grava e acerta só o que está "a classificar"');
  {
    const b = criarBanco({
      regras_negocio: [],
      lancamentos_negocio: [
        { id: 'l1', empresa_id: 'e1', tipo: 'entrada', descricao: 'PIX RECEBIDO JOAO DA SILVA', categoria: 'a_classificar' },
        { id: 'l2', empresa_id: 'e1', tipo: 'entrada', descricao: 'PIX RECEBIDO JOAO DA SILVA', categoria: 'outra_escolha' },
        { id: 'l3', empresa_id: 'e1', tipo: 'saida', descricao: 'PIX ENVIADO JOAO DA SILVA', categoria: 'a_classificar' },
        { id: 'l4', empresa_id: 'e2', tipo: 'entrada', descricao: 'PIX RECEBIDO JOAO DA SILVA', categoria: 'a_classificar' },
        { id: 'l5', empresa_id: 'e1', tipo: 'entrada', descricao: 'PIX RECEBIDO MARIA', categoria: 'a_classificar' },
      ],
    });
    const r = await aprender({ empresaId: 'e1', userId: 'u1', descricao: 'Pix recebido JOAO DA SILVA', tipo: 'entrada', categoria: 'servico' }, { supabase: b.client });
    eq(r.termo, 'joao silva', '§4 grava o termo');
    eq(r.aplicadas, 1, '§4 acerta um');
    const cat = Object.fromEntries(b.tabelas.lancamentos_negocio.map((l) => [l.id, l.categoria]));
    eq(cat.l1, 'servico', '§4 o "a classificar" que casa é acertado');
    eq(cat.l2, 'outra_escolha', '§4 a escolha da pessoa NUNCA é sobrescrita');
    eq(cat.l3, 'a_classificar', '§4 outro sentido fica');
    eq(cat.l4, 'a_classificar', '§4 outra empresa fica');
    eq(cat.l5, 'a_classificar', '§4 outro nome fica');
    eq(b.tabelas.regras_negocio.length, 1, '§4 uma regra');

    // Mudar de ideia: a mesma descrição com outra categoria ATUALIZA a regra.
    await aprender({ empresaId: 'e1', userId: 'u1', descricao: 'PIX JOAO DA SILVA', tipo: 'entrada', categoria: 'consultoria' }, { supabase: b.client });
    eq(b.tabelas.regras_negocio.length, 1, '§4 não duplica a regra');
    eq(b.tabelas.regras_negocio[0].categoria, 'consultoria', '§4 atualiza a categoria');
  }
  {
    const b = criarBanco({ regras_negocio: [], lancamentos_negocio: [] });
    const g = await aprender({ empresaId: 'e1', descricao: 'PIX RECEBIDO', tipo: 'entrada', categoria: 'servico' }, { supabase: b.client });
    eq([g.termo, g.motivo], [null, 'generica'], '§4 genérica: avisa e não grava');
    eq(b.tabelas.regras_negocio.length, 0, '§4 nada gravado');
    const s = await aprender({ empresaId: 'e1', descricao: 'PIX JOAO SILVA', tipo: 'entrada', categoria: 'a_classificar' }, { supabase: b.client });
    eq(s.motivo, 'sem_categoria', '§4 "a classificar" não é categoria');
    const sem = criarBanco({ lancamentos_negocio: [] }, { semTabela: true });
    const m = await aprender({ empresaId: 'e1', descricao: 'PIX JOAO SILVA', tipo: 'entrada', categoria: 'servico' }, { supabase: sem.client });
    eq(m.motivo, 'sem_migration', '§4 sem a 192: avisa, não quebra');
  }
  console.log('  ok');

  if (falhas.length) {
    console.error(`\n✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('\n✓ aprende do caixa da empresa: todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
