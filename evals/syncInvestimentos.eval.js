// =============================================================================
// EVAL — sync de investimentos: escrever só o que mudou, e em LOTE.
//
// ⚠️ EGRESS. Medido em 16/09/2026 com `pg_stat_statements`, em 51,5h:
//     62.648  SELECT investimentos.id          (2 por investimento, por sync)
//     44.867  UPDATE investimentos             (regravava tudo igual)
//     23.900  INSERT investimento_movimentos   (numa tabela de 502 linhas!)
//      7.189  UPDATE investimentos (fallback)
//   = 140.442 de 294.905 requisições — 47,6% de TODAS as idas ao banco.
//
// O que este eval trava:
//   1. EQUIVALÊNCIA DE ESTADO. Pular o UPDATE não pode mudar a tabela: o
//      resultado tem de ser idêntico ao de gravar sempre (que é o que a versão
//      antiga fazia), campo a campo, exceto `ultima_atualizacao`.
//   2. O QUE MUDOU CONTINUA GRAVANDO. É o erro perigoso: dizer "igual" pra algo
//      diferente congela o dado do cliente em silêncio. Seção 3 cobre valor,
//      texto, data, nulo, zero e booleano.
//   3. A CONTAGEM DE IDAS CAI. Seções 2 e 5 comparam os números.
//   4. As TOLERÂNCIAS seguem: migration 138 ausente (coluna nova) e migration
//      139 ausente (tabela de movimentações) não podem derrubar o sync.
//
// Roda sem banco e sem rede: Supabase falso em memória (conta cada ida) e a
// Celcoin stubada.
// Rodar:  npm run eval:sync-investimentos
// =============================================================================
const path = require('path');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── Supabase falso ──────────────────────────────────────────────────────────
function criarBanco({ investimentos = [], movimentos = null, colunasAusentes = [] } = {}) {
  const tabelas = {
    investimentos: investimentos.map((r) => ({ ...r })),
    // `movimentos: null` = migration 139 não rodou (a tabela não existe).
    investimento_movimentos: movimentos === null ? null : movimentos.map((r) => ({ ...r })),
  };
  const stats = { selects: 0, updates: 0, inserts: 0, upserts: 0 };
  const ausente = new Set(colunasAusentes);
  const idSeq = { n: 1 };

  const erroColuna = (col) => ({ message: `column "${col}" of relation "investimentos" does not exist` });
  const erroTabela = (t) => ({ message: `relation "public.${t}" does not exist` });

  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, colunas = '*', unica = null, retorno = false, faixa = null;

    const projetar = (r) => {
      if (colunas === '*') return { ...r };
      const o = {};
      colunas.split(',').map((x) => x.trim()).forEach((k) => { o[k] = r[k] ?? null; });
      return o;
    };

    const api = {
      select(c) {
        if (modo === 'select') colunas = c || '*'; else retorno = true;
        return api;
      },
      insert(rows) { modo = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows) { modo = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      range(a, b) { faixa = [a, b]; return api; },
      maybeSingle() { unica = 'maybe'; return api; },
      single() { unica = 'single'; return api; },
      then(resolver, rejeitar) {
        try {
          const tabela = tabelas[nome];
          if (tabela === null || tabela === undefined) {
            return Promise.resolve({ data: null, error: erroTabela(nome) }).then(resolver, rejeitar);
          }
          const alvo = tabela.filter((r) => filtros.every((f) => f(r)));

          if (modo === 'update' || modo === 'insert' || modo === 'upsert') {
            const linhas = modo === 'update' ? [payload] : payload;
            for (const l of linhas) {
              for (const k of Object.keys(l || {})) {
                if (ausente.has(k)) {
                  return Promise.resolve({ data: null, error: erroColuna(k) }).then(resolver, rejeitar);
                }
              }
            }
          }

          if (modo === 'update') {
            stats.updates++;
            alvo.forEach((r) => Object.assign(r, payload));
            return Promise.resolve({ data: null, error: null }).then(resolver, rejeitar);
          }

          if (modo === 'insert' || modo === 'upsert') {
            stats[modo === 'insert' ? 'inserts' : 'upserts']++;
            const gravadas = [];
            for (const l of payload) {
              // Upsert de movimentação: a unique (investimento_id, of_mov_id)
              // é quem manda — reaproveita a linha em vez de duplicar.
              const ja = nome === 'investimento_movimentos'
                ? tabela.find((r) => r.investimento_id === l.investimento_id && r.of_mov_id === l.of_mov_id)
                : null;
              if (ja && modo === 'upsert') { Object.assign(ja, l); gravadas.push(ja); continue; }
              const nova = { id: `novo-${idSeq.n++}`, ...l };
              tabela.push(nova);
              gravadas.push(nova);
            }
            const data = retorno
              ? (unica ? (gravadas[0] ? projetar(gravadas[0]) : null) : gravadas.map(projetar))
              : null;
            return Promise.resolve({ data, error: null }).then(resolver, rejeitar);
          }

          // Coluna que não existe derruba a LEITURA também — é o que faz o
          // caminho de fallback pro `select('*')` ser exercitado de verdade.
          if (colunas !== '*') {
            for (const k of colunas.split(',').map((x) => x.trim())) {
              if (ausente.has(k)) {
                return Promise.resolve({ data: null, error: erroColuna(k) }).then(resolver, rejeitar);
              }
            }
          }

          stats.selects++;
          let linhas = alvo;
          if (faixa) linhas = linhas.slice(faixa[0], faixa[1] + 1);
          // O PostgREST corta em 1000 mesmo sem range — é o corte silencioso
          // que a paginação existe pra sobreviver.
          linhas = linhas.slice(0, 1000);
          if (unica) {
            if (unica === 'maybe' && linhas.length > 1) {
              return Promise.resolve({ data: null, error: { message: 'multiple rows' } }).then(resolver, rejeitar);
            }
            return Promise.resolve({ data: linhas[0] ? projetar(linhas[0]) : null, error: null }).then(resolver, rejeitar);
          }
          return Promise.resolve({ data: linhas.map(projetar), error: null }).then(resolver, rejeitar);
        } catch (e) {
          return Promise.reject(e).then(resolver, rejeitar);
        }
      },
    };
    return api;
  }

  return { client: { from }, tabelas, stats };
}

// Carrega o sync com o banco falso e a Celcoin stubada.
function carregarSync(banco, movimentosDaApi = []) {
  const alvo = path.resolve(__dirname, '../src/services/polpCelcoinSync.js');
  const db = path.resolve(__dirname, '../src/db/supabase.js');
  const cel = path.resolve(__dirname, '../src/services/polpCelcoin.js');
  delete require.cache[alvo];
  require.cache[db] = { id: db, filename: db, loaded: true, exports: banco.client };
  // A Celcoin entra stubada ANTES de o sync ser carregado: sem isto o eval
  // dependeria de rede e de credencial.
  require.cache[cel] = {
    id: cel, filename: cel, loaded: true,
    exports: { listarTransacoesInvestimento: async () => movimentosDaApi },
  };
  return require(alvo);
}

const investimentoDaApi = (over = {}) => ({
  externalId: 'of-1', tipo: 'Ações', nome: 'PETR4', ticker: 'PETR4.SA',
  quantidade: 8, preco_unitario: 33.43, valor_aportado: 267.44, valor_atual: 391.6,
  rentabilidade: 0.46, moeda: 'BRL', data_compra: '2026-01-10', data_vencimento: null,
  indexador: null, percentual_indexador: null, taxa_anual: null,
  nome_completo: 'Petrobras', setor: 'Energia',
  ...over,
});

// A linha como o banco a devolveria depois de um sync anterior.
const linhaGravada = (over = {}) => ({
  id: 'inv-1', grupo_id: 'g1', of_id: 'of-1', of_provider: 'polp-celcoin', origem: 'of',
  tipo: 'Ações', nome: 'PETR4', ticker: 'PETR4.SA',
  quantidade: 8, preco_unitario: 33.43, valor_aportado: 267.44, valor_atual: 391.6,
  rentabilidade: 0.46, moeda: 'BRL', data_compra: '2026-01-10', data_vencimento: null,
  indexador: null, percentual_indexador: null, taxa_anual: null,
  nome_completo: 'Petrobras', setor: 'Energia',
  ultima_atualizacao: '2026-09-15T10:00:00.000Z',
  ...over,
});

const semCarimbo = (r) => { const o = { ...r }; delete o.ultima_atualizacao; return o; };

// ── 1. Comparação de valores: o coração da decisão ─────────────────────────
console.log('── 1. mesmoValor / algoMudou ──');
{
  const banco = criarBanco();
  const S = carregarSync(banco);

  // Iguais
  ok(S.mesmoValor(10, 10), '10 = 10');
  ok(S.mesmoValor(null, null), 'null = null');
  ok(S.mesmoValor(undefined, null), 'undefined e null são o mesmo vazio');
  ok(S.mesmoValor('abc', 'abc'), 'texto igual');
  ok(S.mesmoValor('2026-01-10', '2026-01-10'), 'data igual');
  // ⚠️ numeric do PostgREST pode vir como string: sem isto o UPDATE nunca seria
  // pulado, e a economia inteira ia embora sem ninguém perceber.
  ok(S.mesmoValor('1234.50', 1234.5), 'numérico em texto = numérico');
  ok(S.mesmoValor(0, 0), 'zero = zero');
  ok(S.mesmoValor(0.1 + 0.2, 0.3), 'folga de ponto flutuante');

  // Diferentes — o lado que NÃO pode falhar
  ok(!S.mesmoValor(10, 10.01), '10 ≠ 10,01 (um centavo conta)');
  ok(!S.mesmoValor(null, 0), '⚠️ null ≠ 0 — "não informado" não é "zero"');
  ok(!S.mesmoValor(0, null), '⚠️ 0 ≠ null');
  ok(!S.mesmoValor('', null), 'vazio ≠ null');
  ok(!S.mesmoValor('abc', 'abd'), 'texto diferente');
  ok(!S.mesmoValor('2026-01-10', '2026-01-11'), 'data diferente');
  ok(!S.mesmoValor(true, 1), '⚠️ booleano não vira número');
  ok(!S.mesmoValor(false, 0), '⚠️ false não é 0');
  ok(!S.mesmoValor({ a: 1 }, { a: 1 }), 'objeto: na dúvida, mudou');

  ok(!S.algoMudou(linhaGravada(), semCarimbo(linhaGravada())), 'linha idêntica não mudou');
  ok(S.algoMudou(linhaGravada(), { valor_atual: 400 }), 'valor diferente mudou');
  ok(!S.algoMudou(linhaGravada(), { ultima_atualizacao: 'qualquer coisa' }),
     '⚠️ só o carimbo de horário NÃO conta como mudança — é o que torna a economia possível');
  ok(S.algoMudou(undefined, { valor_atual: 1 }), 'sem linha atual, mudou');

  // ── 1B. O FORMATO QUE O BANCO DEVOLVE DE VERDADE (18/09/2026) ──────────────
  // ⚠️ A seção acima comparava data pura com data pura, e por isso PASSOU com a
  // economia zerada em produção: `data_compra` é `timestamptz` e volta como
  // "2026-01-15T00:00:00+00:00" — contra o "2026-01-15" que o sync escreve.
  // Medido: 31.880 leituras e 31.879 UPDATEs em 38h; simulando nas 633 linhas
  // reais, a regra antiga regravava as 633 e a nova, nenhuma.
  ok(S.mesmoValor('2026-01-15T00:00:00+00:00', '2026-01-15'), '⚠️ data do timestamptz = data escrita');
  ok(S.mesmoValor('2026-01-15', '2026-01-15T00:00:00Z'), 'nos dois sentidos, e com Z');
  ok(S.mesmoValor('2026-01-15T00:00:00.000+00:00', '2026-01-15'), 'com milissegundos zerados');
  ok(!S.mesmoValor('2026-01-15T00:00:00+00:00', '2026-01-16'), 'dia diferente segue diferente');
  ok(!S.mesmoValor('2026-01-15T14:30:00+00:00', '2026-01-15'), '⚠️ horário DE VERDADE não vira "mesma data"');
  ok(!S.mesmoValor('2026-01-15T00:00:00-03:00', '2026-01-15'), 'meia-noite de outro fuso é outro instante');

  // ⚠️ E a rentabilidade: o banco guarda 6 casas; o float cru nunca batia.
  // 100 de lucro sobre 900 = 0,1111… — dízima, como é quase sempre na vida real
  // (uma conta exata como 0,06762 esconderia o defeito: o float cru bateria).
  const inv = S.normalizeInvestimento({
    id: 'x', __familia: 'bank_fixed_incomes',
    balance: { net_amount: '1000', quantity: '3', purchase_unit_price: '300' },
    product: {},
  });
  ok(Math.abs(inv.rentabilidade * 1e6 - Math.round(inv.rentabilidade * 1e6)) < 1e-6,
     `rentabilidade sai com no máximo 6 casas — veio ${inv.rentabilidade}`);
  ok(!S.algoMudou({ rentabilidade: 0.111111, valor_atual: 1000 }, { rentabilidade: inv.rentabilidade, valor_atual: inv.valor_atual }),
     `⚠️ a linha gravada (0,111111) não é regravada — veio ${inv.rentabilidade}`);
}
console.log('  ok');

// As seções que tocam o banco são assíncronas: rodam em sequência aqui.
async function principal() {
  // ── 2. Investimento que NÃO mudou: pula o UPDATE, estado intacto ─────────
  console.log('── 2. nada mudou → nenhuma escrita ──');
  {
    const banco = criarBanco({ investimentos: [linhaGravada()] });
    const S = carregarSync(banco);
    const antes = JSON.parse(JSON.stringify(banco.tabelas.investimentos));

    const r = await S.upsertInvestimento('g1', investimentoDaApi());

    ok(r.resultado === 'inalterado', `deveria ser 'inalterado', veio '${r.resultado}'`);
    ok(r.id === 'inv-1', 'devolve o id pra evitar a 2ª leitura');
    ok(banco.stats.updates === 0, `⚠️ nenhum UPDATE deveria acontecer, houve ${banco.stats.updates}`);
    ok(banco.stats.selects === 1, `1 leitura só, houve ${banco.stats.selects}`);
    ok(JSON.stringify(banco.tabelas.investimentos) === JSON.stringify(antes),
       'a tabela não pode ter mudado');
  }
  console.log('  ok');

  // ── 3. QUALQUER campo diferente volta a gravar ───────────────────────────
  console.log('── 3. mudou de verdade → grava (o erro perigoso) ──');
  {
    const mudancas = [
      ['valor_atual', 400.12],
      ['valor_aportado', 300],
      ['quantidade', 9],
      ['preco_unitario', 34.10],
      ['rentabilidade', 0.5],
      ['nome', 'PETR4 novo'],
      ['ticker', 'PETR3.SA'],
      ['tipo', 'FIIs'],
      ['data_compra', '2026-02-01'],
      ['data_vencimento', '2030-01-01'],   // era null
      ['setor', null],                     // era texto
      ['taxa_anual', 12.5],                // era null
      ['moeda', 'USD'],
    ];
    for (const [campo, valor] of mudancas) {
      const banco = criarBanco({ investimentos: [linhaGravada()] });
      const S = carregarSync(banco);
      const r = await S.upsertInvestimento('g1', investimentoDaApi({ [campo]: valor }));
      ok(r.resultado === 'atualizado', `campo "${campo}" mudou e NÃO gravou — dado congelaria`);
      ok(banco.stats.updates === 1, `campo "${campo}": deveria ter 1 UPDATE`);
      const linha = banco.tabelas.investimentos[0];
      ok(String(linha[campo] ?? null) === String(valor ?? null),
         `campo "${campo}" deveria valer ${valor}, ficou ${linha[campo]}`);
    }
  }
  console.log('  ok');

  // ── 4. EQUIVALÊNCIA com a versão antiga (que gravava sempre) ─────────────
  console.log('── 4. estado final igual ao de gravar sempre ──');
  {
    for (const over of [{}, { valor_atual: 999.99 }, { nome: 'Outro' }, { taxa_anual: 3 }]) {
      const banco = criarBanco({ investimentos: [linhaGravada()] });
      const S = carregarSync(banco);
      await S.upsertInvestimento('g1', investimentoDaApi(over));
      const novo = semCarimbo(banco.tabelas.investimentos[0]);

      // A versão ANTIGA era exatamente "aplica o patch, sempre". Reproduzir o
      // patch sobre o estado inicial dá o estado que ela deixaria.
      const antigo = semCarimbo({ ...linhaGravada(), ...semCarimbo(investimentoDaApi(over)) });
      delete antigo.externalId;   // não é coluna; o `limpo` do sync não a inclui

      for (const k of Object.keys(antigo)) {
        ok(String(novo[k] ?? null) === String(antigo[k] ?? null),
           `divergiu em "${k}" com ${JSON.stringify(over)}: novo=${novo[k]} antigo=${antigo[k]}`);
      }
    }
  }
  console.log('  ok');

  // ── 5. Investimento NOVO continua sendo criado, e devolve id ─────────────
  console.log('── 5. criação ──');
  {
    const banco = criarBanco({ investimentos: [] });
    const S = carregarSync(banco);
    const r = await S.upsertInvestimento('g1', investimentoDaApi());
    ok(r.resultado === 'criado', `deveria criar, veio '${r.resultado}'`);
    ok(!!r.id, 'criação precisa devolver o id (é ele que evita a 2ª leitura)');
    ok(banco.tabelas.investimentos.length === 1, 'deveria ter 1 investimento');
    const l = banco.tabelas.investimentos[0];
    // ⚠️ `S.PROVIDER` em vez da string na mão: é o valor que o resto do sistema
    // usa pra reconhecer a linha como "do banco" (inclusive a trava de aporte
    // manual). Cravar 'celcoin' aqui fez este teste falhar por engano.
    ok(l.of_id === 'of-1' && l.origem === 'of' && l.of_provider === S.PROVIDER,
       `marcas de origem do Open Finance têm de ficar (of_provider=${l.of_provider})`);
  }
  console.log('  ok');

  // ── 6. TOLERÂNCIA: migration 138 (colunas novas) não rodou ──────────────
  console.log('── 6. migration 138 ausente ──');
  {
    // Update: a 1ª tentativa falha por coluna inexistente, a 2ª grava o básico.
    const banco = criarBanco({
      investimentos: [linhaGravada()], colunasAusentes: ['carencia_ate'],
    });
    const S = carregarSync(banco);
    const r = await S.upsertInvestimento('g1', investimentoDaApi({ valor_atual: 500, carencia_ate: '2027-01-01' }));
    ok(r.resultado === 'atualizado', 'com coluna ausente ainda deve atualizar');
    ok(banco.tabelas.investimentos[0].valor_atual === 500,
       'o valor básico precisa ter sido gravado mesmo sem a coluna nova');

    // Insert: mesmo caminho.
    const banco2 = criarBanco({ investimentos: [], colunasAusentes: ['carencia_ate'] });
    const S2 = carregarSync(banco2);
    const r2 = await S2.upsertInvestimento('g1', investimentoDaApi({ carencia_ate: '2027-01-01' }));
    ok(r2.resultado === 'criado', 'com coluna ausente ainda deve criar');
    ok(banco2.tabelas.investimentos.length === 1, 'o investimento não pode se perder');
  }
  console.log('  ok');

  // ── 7. MOVIMENTAÇÕES: lote, e só o que falta ────────────────────────────
  console.log('── 7. movimentações em lote ──');
  {
    const daApi = [
      { id: 'm1', transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 100 },
      { id: 'm2', transaction_date: '2026-09-02', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 200 },
      { id: 'm3', transaction_date: '2026-09-03', type: 'SAIDA',   transaction_type: 'RESGATE',   transaction_net_value: 50 },
    ];
    // m1 e m2 já estão gravadas; só a m3 é nova.
    const banco = criarBanco({
      investimentos: [linhaGravada()],
      movimentos: [
        { id: 'x1', grupo_id: 'g1', investimento_id: 'inv-1', of_mov_id: 'm1' },
        { id: 'x2', grupo_id: 'g1', investimento_id: 'inv-1', of_mov_id: 'm2' },
      ],
    });
    const S = carregarSync(banco, daApi);
    const n = await S.sincronizarMovimentos('g1', '/investments/x', 'of-1', 'inv-1');

    ok(n === 1, `deveria gravar 1 movimentação nova, gravou ${n}`);
    ok(banco.stats.upserts === 1, `⚠️ 1 gravação em LOTE, houve ${banco.stats.upserts}`);
    ok(banco.stats.selects === 1, `1 leitura (a dos já gravados), houve ${banco.stats.selects}`);
    ok(banco.tabelas.investimento_movimentos.length === 3, 'a tabela deveria ficar com 3 linhas');

    // Rodar de novo (o sync roda de hora em hora) não pode escrever nada.
    const antes = banco.stats.upserts;
    const n2 = await S.sincronizarMovimentos('g1', '/investments/x', 'of-1', 'inv-1');
    ok(n2 === 0, 'segunda passada não tem nada novo');
    ok(banco.stats.upserts === antes, '⚠️ segunda passada NÃO pode gravar — era exatamente o desperdício');
    ok(banco.tabelas.investimento_movimentos.length === 3, 'nem duplicar linha');
  }
  console.log('  ok');

  // ── 8. Movimentação repetida no MESMO payload ───────────────────────────
  console.log('── 8. payload com id repetido ──');
  {
    const daApi = [
      { id: 'm9', transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 10 },
      { id: 'm9', transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 10 },
    ];
    const banco = criarBanco({ investimentos: [linhaGravada()], movimentos: [] });
    const S = carregarSync(banco, daApi);
    const n = await S.sincronizarMovimentos('g1', '/x', 'of-1', 'inv-1');
    ok(n === 1, `id repetido deveria virar 1 linha, virou ${n}`);
    ok(banco.tabelas.investimento_movimentos.length === 1, 'não pode duplicar no banco');
  }
  console.log('  ok');

  // ── 9. TOLERÂNCIA: migration 139 (tabela) não rodou ─────────────────────
  console.log('── 9. migration 139 ausente ──');
  {
    const banco = criarBanco({ investimentos: [linhaGravada()], movimentos: null });
    const S = carregarSync(banco, [{ id: 'm1', transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 1 }]);
    let estourou = false;
    let n = null;
    try { n = await S.sincronizarMovimentos('g1', '/x', 'of-1', 'inv-1'); }
    catch { estourou = true; }
    ok(!estourou, '⚠️ sem a tabela, NÃO pode estourar — derrubaria o sync inteiro');
    ok(n === 0, `deveria devolver 0, devolveu ${n}`);
  }
  console.log('  ok');

  // ── 10. Sem o id vindo de fora, ainda funciona (compatibilidade) ────────
  console.log('── 10. chamada sem o id (caminho antigo) ──');
  {
    const banco = criarBanco({
      investimentos: [linhaGravada()], movimentos: [],
    });
    const S = carregarSync(banco, [{ id: 'm1', transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 1 }]);
    const n = await S.sincronizarMovimentos('g1', '/x', 'of-1');   // sem o 4º argumento
    ok(n === 1, 'sem o id, precisa buscar sozinho e funcionar igual');
    ok(banco.stats.selects === 2, `sem o id são 2 leituras (busca + já gravados), houve ${banco.stats.selects}`);
  }
  console.log('  ok');

  // ── 11. A CONTA DO CORTE ─────────────────────────────────────────────────
  console.log('── 11. quantas idas o sync faz agora ──');
  {
    // 10 investimentos já gravados e sem mudança, cada um com 3 movimentações
    // já sincronizadas — o dia a dia de quem tem a carteira parada.
    const invs = [];
    const movs = [];
    for (let i = 1; i <= 10; i++) {
      invs.push(linhaGravada({ id: `inv-${i}`, of_id: `of-${i}` }));
      for (let m = 1; m <= 3; m++) movs.push({ id: `x${i}-${m}`, grupo_id: 'g1', investimento_id: `inv-${i}`, of_mov_id: `m${i}-${m}` });
    }
    const banco = criarBanco({ investimentos: invs, movimentos: movs });

    let idas = 0;
    for (let i = 1; i <= 10; i++) {
      const daApi = [1, 2, 3].map((m) => ({ id: `m${i}-${m}`, transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO', transaction_net_value: 1 }));
      const S = carregarSync(banco, daApi);
      const r = await S.upsertInvestimento('g1', investimentoDaApi({ externalId: `of-${i}` }));
      await S.sincronizarMovimentos('g1', '/x', `of-${i}`, r.id);
    }
    idas = banco.stats.selects + banco.stats.updates + banco.stats.inserts + banco.stats.upserts;

    // Agora: 1 leitura do investimento + 1 leitura das movimentações = 2 por papel.
    ok(idas === 20, `deveriam ser 20 idas (2 por investimento), foram ${idas}`);
    ok(banco.stats.updates === 0, 'nada mudou: zero UPDATE');
    ok(banco.stats.upserts === 0, 'nada novo: zero gravação de movimentação');

    // Antes: 2 leituras + 1 update + 3 upserts = 6 por papel = 60.
    const antes = 10 * (2 + 1 + 3);
    ok(antes === 60, 'sanidade da conta antiga');
    console.log(`     antes ~${antes} idas · agora ${idas} — corte de ${Math.round((1 - idas / antes) * 100)}%`);
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.log(`❌ ${falhas.length} falha(s):`);
    for (const f of falhas) console.log('   · ' + f);
    process.exit(1);
  }
  console.log('✅ sync de investimentos: tudo passou');
}

principal().catch((e) => { console.error('ERRO NO EVAL:', e); process.exit(1); });
