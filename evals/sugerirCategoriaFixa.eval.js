// =============================================================================
// EVAL da sugestão de categoria pras contas fixas em "Outros".
//
// CONTEXTO: 61 de 190 recorrências ativas estão em "Outros" (medido na base).
// A Sora sugere a categoria lendo o que o usuário JÁ fez nas transações reais
// do mesmo estabelecimento.
//
// O RISCO que este eval existe pra segurar: sugestão errada é pior que nenhuma.
// Ela é aceita com 1 clique, entra em relatório/limite/Wrapped, e o usuário não
// descobre que foi a Sora que errou. Então a régua é "na dúvida, não sugere".
//
// Rodar:  npm run eval:sugerir-categoria
// =============================================================================
const { casa, dominante } = require('../src/services/sugerirCategoriaFixa');
const { chaveDe } = require('../src/services/detectarRecorrencias');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. Casamento de descrição ──────────────────────────────────────────────
console.log('── 1. casar conta fixa × transação ──');
{
  const k = (s) => chaveDe(s);
  ok(casa(k('Netflix'), k('NETFLIX.COM')), 'usuário digita "Netflix", banco manda "NETFLIX.COM"');
  ok(casa(k('Spotify'), k('SPOTIFY BR 123')), 'número no meio não atrapalha');
  ok(casa(k('Academia'), k('ACADEMIA')), 'igual casa');
  ok(casa(k('Aluguel apartamento'), k('ALUGUEL')), 'transação mais curta que a conta fixa');

  // O que NÃO pode casar — cada um destes viraria sugestão errada.
  ok(!casa(k('Luz'), k('CRUZEIRO DO SUL')), '"luz" não casa com "cruzeiro" (curto demais)');
  ok(!casa(k('Netflix'), k('SPOTIFY')), 'lojas diferentes não casam');
  ok(!casa('', k('NETFLIX')), 'descrição vazia não casa');
  ok(!casa(k('Netflix'), ''), 'transação sem descrição não casa');
}
console.log('  ok');

// ── 2. Categoria dominante ─────────────────────────────────────────────────
// Aqui mora a régua do "na dúvida não sugere".
console.log('── 2. escolher a categoria ──');
{
  const d1 = dominante(['Assinaturas', 'Assinaturas', 'Assinaturas']);
  eq(d1.categoria, 'Assinaturas', 'unanimidade sugere');
  eq(d1.ocorrencias, 3, 'conta as ocorrências');

  const d2 = dominante(['Assinaturas', 'Assinaturas', 'Lazer']);
  eq(d2.categoria, 'Assinaturas', 'maioria clara sugere');

  // Uma ocorrência só pode ser lançamento avulso — não é evidência.
  eq(dominante(['Assinaturas']), null, 'uma ocorrência só NÃO sugere');

  // Empate: nem o usuário decidiu. Sugerir aqui seria escolher por ele.
  eq(dominante(['Assinaturas', 'Lazer']), null, 'empate NÃO sugere');
  eq(dominante(['A', 'A', 'B', 'B']), null, 'empate com repetição NÃO sugere');

  // Pluralidade sem maioria não basta: 2 de 4 é o mais votado, mas metade das
  // vezes o usuário categorizou de outro jeito.
  eq(dominante(['A', 'A', 'B', 'C']), null, 'pluralidade sem maioria NÃO sugere');
  // Passando de 50%, sugere.
  eq(dominante(['A', 'A', 'A', 'B', 'C']).categoria, 'A', '3 de 5 (60%) sugere');

  eq(dominante([]), null, 'lista vazia não quebra');
}
console.log('  ok');

// ── 3. Casos reais da base ─────────────────────────────────────────────────
console.log('── 3. casos reais ──');
{
  const k = (s) => chaveDe(s);
  // Estes são nomes que aparecem de verdade nas recorrências em "Outros".
  const cenarios = [
    { fixa: 'Netflix',   tx: 'NETFLIX.COM',            casa: true  },
    { fixa: 'Internet',  tx: 'VIVO FIBRA INTERNET',    casa: true  },
    { fixa: 'Condomínio', tx: 'CONDOMINIO EDIFICIO',   casa: true  },
    { fixa: 'Academia',  tx: 'SMARTFIT ACADEMIA',      casa: true  },
    // Sem laço textual: a Sora não pode inventar que "luz" é "CEMIG".
    { fixa: 'Conta de luz', tx: 'CEMIG DISTRIBUICAO',  casa: false },
    { fixa: 'Aluguel',   tx: 'PIX ENVIADO JOAO',       casa: false },
  ];
  for (const c of cenarios) {
    eq(casa(k(c.fixa), k(c.tx)), c.casa, `"${c.fixa}" × "${c.tx}"`);
  }
}
console.log('  ok');

// ── 4. Regressão: 'natura' dentro de "asSINATURA" ──────────────────────────
// Achado ao revisar as sugestões reais: "Assinatura Sora Premium" saía como
// Autocuidado. A keyword 'natura' (a marca) casava como SUBSTRING dentro de
// "assinatura" — e isso afetava toda transação com "Assinatura X", não só
// esta feature. Consertado com '=natura' (palavra inteira).
console.log('── 4. natura × assinatura ──');
{
  const { categorizarDescricao } = require('../src/services/categorizar');
  eq(categorizarDescricao('Assinatura Sora Premium'), 'Assinaturas', '"Assinatura X" é Assinaturas, não Autocuidado');
  eq(categorizarDescricao('assinatura'), 'Assinaturas', '"assinatura" sozinha');
  // E a marca não pode ter quebrado no conserto.
  eq(categorizarDescricao('Natura'), 'Autocuidado', 'a marca Natura continua Autocuidado');
  eq(categorizarDescricao('natura cosmeticos'), 'Autocuidado', 'Natura com complemento também');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ sugestão de categoria: todos os casos passaram');
