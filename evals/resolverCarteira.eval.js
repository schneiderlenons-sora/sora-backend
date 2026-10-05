// =============================================================================
// EVAL — "de qual conta saiu?" (`resolverCarteiraReal`).
//
// Relato (eliasmartins, out/2026): "a gente lança algo e ela diz que não
// encontrou a conta". Reproduzido com as contas REAIS dele: dizer "nubank" não
// achava "Nubank Crédito", "vendas" não achava "INFINITEPAY VENDAS", e
// "INFINITEPAY␣␣AFIAÇÃO" (dois espaços) não batia nem com o nome escrito igual.
//
// ⚠️ O RISCO DESTA FUNÇÃO NÃO É FALHAR — é ACERTAR A CONTA ERRADA. Falhar faz
// a Sora perguntar, que é chato e recuperável. Escolher sozinha a conta errada
// lança o dinheiro no lugar errado em silêncio. Por isso o §1 inteiro é sobre
// NÃO decidir quando há ambiguidade.
//
// Roda sem banco: `resolverCarteiraReal` aceita a lista de contas injetada.
//
// Rodar: node evals/resolverCarteira.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';

const { resolverCarteiraReal } = require('../src/handlers/transacoes');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const contas = (...nomes) => nomes.map((nome, i) => ({ id: 'w' + i, nome, tipo: 'Corrente' }));
const r = (dito, lista) => resolverCarteiraReal('g1', dito, lista);

(async () => {
  console.log('-- 1. O CASO PERIGOSO: "Nubank" E "Nubank Credito" juntos --');
  {
    const duas = contas('Nubank', 'Nubank Crédito');
    // Existe uma conta chamada exatamente "Nubank": o match EXATO resolve antes
    // de qualquer heuristica. Este caso nao pode mudar nunca.
    eq(await r('nubank', duas), 'Nubank', '§1 "nubank" -> a conta exata, NAO o cartao');
    eq(await r('Nubank', duas), 'Nubank', '§1 maiuscula idem');
    eq(await r('nubank credito', duas), 'Nubank Crédito', '§1 "nubank credito" -> o cartao');
    eq(await r('nubank crédito', duas), 'Nubank Crédito', '§1 com acento idem');
    eq(await r('no nubank', duas), 'Nubank', '§1 com preposicao -> a conta exata');
    eq(await r('cartão nubank', duas), 'Nubank', '§1 "cartao nubank": o ruido sai e sobra o exato');
  }
  {
    // ⚠️ SEM conta exata, mas DUAS que contem o termo: nao da pra decidir.
    const ambiguas = contas('Nubank Crédito', 'Nubank Vendas');
    eq(await r('nubank', ambiguas), null, '§1 DUAS candidatas -> NAO decide (pergunta)');
    eq(await r('nubank credito', ambiguas), 'Nubank Crédito', '§1 mas o nome completo decide');
    eq(await r('nubank vendas', ambiguas), 'Nubank Vendas', '§1 idem a outra');
  }
  {
    // ⚠️ ESTE CASO E O QUE PROVA A TRAVA, e so apareceu na MUTACAO: sem o
    // `return null` do ambiguo, o fuzzy assume e CHUTA. Com nome longo e
    // sufixo curto a similaridade passa de 0.8, entao "mercadopago" voltava
    // "Mercadopago A" — dinheiro lancado numa das duas contas, em silencio,
    // sem a pessoa ser perguntada. E o formato real das contas do relato
    // ("INFINITEPAY VENDAS" / "INFINITEPAY  AFIAÇÃO").
    const longas = contas('Mercadopago A', 'Mercadopago B');
    eq(await r('mercadopago', longas), null, '§1 AMBIGUO NAO CAI NO FUZZY (ele chutaria)');
    eq(await r('mercadopago a', longas), 'Mercadopago A', '§1 e o nome completo segue decidindo');
  }
  {
    // ⚠️ 1 CARACTERE NAO DECIDE. Com o minimo em 1, uma letra solta sobrando
    // na frase viraria candidata e escolheria a conta sozinha.
    const c = contas('Banco A', 'Conta B');
    eq(await r('a', c), null, '§1 termo de 1 letra nao resolve conta');
    eq(await r('b', c), null, '§1 idem');
  }
  console.log('  ok');

  console.log('-- 2. O BUG DO RELATO: nome parcial acha a conta unica --');
  {
    const c = contas('Nubank Crédito', 'PAGBANK', 'Mercado pago');
    eq(await r('nubank', c), 'Nubank Crédito', '§2 "nubank" -> "Nubank Credito" (era null)');
    eq(await r('no nubank', c), 'Nubank Crédito', '§2 com preposicao');
    eq(await r('cartão nubank', c), 'Nubank Crédito', '§2 com a palavra cartao');
  }
  {
    const c = contas('INFINITEPAY VENDAS', 'PAGBANK', 'Carteira AFIAÇÃO');
    eq(await r('vendas', c), 'INFINITEPAY VENDAS', '§2 "vendas" acha a unica que a contem');
    eq(await r('afiacao', c), 'Carteira AFIAÇÃO', '§2 "afiacao" sem acento acha "AFIAÇÃO"');
    eq(await r('afiação', c), 'Carteira AFIAÇÃO', '§2 com acento idem');
  }
  console.log('  ok');

  console.log('-- 3. ESPACO DUPLO no nome cadastrado --');
  {
    // Caso real: a conta foi cadastrada com dois espacos e o nome "igual" nao batia.
    const c = contas('INFINITEPAY  AFIAÇÃO', 'PAGBANK');
    eq(await r('infinitepay afiação', c), 'INFINITEPAY  AFIAÇÃO', '§3 um espaco acha o de dois');
    eq(await r('INFINITEPAY  AFIAÇÃO', c), 'INFINITEPAY  AFIAÇÃO', '§3 e o proprio nome tambem');
  }
  console.log('  ok');

  console.log('-- 4. NAO INVENTA conta que nao existe --');
  {
    const c = contas('PAGBANK', 'PicPay');
    eq(await r('nubank', c), null, '§4 conta inexistente -> null');
    eq(await r('itau', c), null, '§4 idem');
    eq(await r('', c), null, '§4 vazio');
    eq(await r('   ', c), null, '§4 so espaco');
    eq(await r('banco', c), null, '§4 so ruido');
    eq(await r('nubank', []), null, '§4 sem conta nenhuma');
  }
  console.log('  ok');

  console.log('-- 5. PEDACO DE PALAVRA nao casa (senao "pay" pegaria 3 contas) --');
  {
    const c = contas('PagBank', 'PicPay', 'InfinitePay');
    eq(await r('pay', c), null, '§5 "pay" NAO casa com PicPay/InfinitePay');
    eq(await r('pag', c), null, '§5 "pag" NAO casa com PagBank');
    eq(await r('picpay', c), 'PicPay', '§5 mas a palavra inteira casa');
  }
  console.log('  ok');

  console.log('-- 6. REGRESSAO: o que ja funcionava continua --');
  {
    const c = contas('Nubank', 'Inter', 'Mercado Pago', 'Carteira');
    eq(await r('nubank', c), 'Nubank', '§6 exato');
    eq(await r('NUBANK', c), 'Nubank', '§6 caixa alta');
    eq(await r('no nubank', c), 'Nubank', '§6 preposicao');
    eq(await r('conta inter', c), 'Inter', '§6 a palavra "conta" e ruido');
    eq(await r('mercado pago', c), 'Mercado Pago', '§6 nome com espaco');
    eq(await r('gastei no mercado pago hoje', c), 'Mercado Pago', '§6 nome dentro da frase');
    // ⚠️ OS DOIS VALORES ABAIXO FORAM MEDIDOS, NAO SUPOSTOS. Eu havia escrito
    // o esperado de cabeca e o eval acusou — mas a "regressao" era do TESTE:
    // conferido com `git stash`, os dois ja se comportavam assim antes desta
    // mudanca. Asserção por palpite num bloco de regressao e pior que nenhuma,
    // porque culpa a mudanca errada.
    eq(await r('nubanc', c), 'Nubank', '§6 typo de troca de letra, pelo fuzzy');
    eq(await r('nubankk', c), 'Nubank', '§6 letra a mais');
    eq(await r('nuban', c), 'Nubank', '§6 letra a menos');
    // Transposicao NAO alcanca o limiar de 0.8 — e ja nao alcancava antes.
    eq(await r('nubnak', c), null, '§6 transposicao fica fora do fuzzy (pre-existente)');
    // Existe uma conta chamada "Carteira": o match EXATO a acha, mesmo
    // "carteira" sendo palavra de ruido na limpeza do passo 2.
    eq(await r('carteira', c), 'Carteira', '§6 conta chamada "Carteira" e achada pelo exato');
    // Sem uma conta com esse nome, "carteira" e so ruido e nao resolve nada.
    eq(await r('carteira', contas('Nubank', 'Inter')), null, '§6 sem a conta, segue sendo ruido');
  }
  console.log('  ok');

  console.log('-- 7. cartoes injetados (comando de fatura/parcelas) --');
  {
    // faturaCartao.js e parcelas.js injetam SO os cartoes e ja tentavam
    // `${termo} credito` como 2a chamada. Com o passo novo a 1a ja resolve.
    const cartoes = [{ id: 'c1', nome: 'Nubank Crédito', tipo: 'Crédito' }];
    eq(await r('nubank', cartoes), 'Nubank Crédito', '§7 "fatura nubank" acha de primeira');
    eq(await r('nubank credito', cartoes), 'Nubank Crédito', '§7 e com o sufixo tambem');
  }
  console.log('  ok');

  console.log('-- 8. a conta do RELATO, inteira --');
  {
    const dele = contas(
      'PAGBANK', 'INFINITEPAY VENDAS Crédito', 'Mercado pago', 'INFINITEPAY VENDAS',
      'PicPay', 'Nubank Crédito', 'Mercado pago Crédito', 'InfinitePay',
      'INFINITEPAY  AFIAÇÃO', 'InfinitePay Crédito', 'Carteira AFIAÇÃO', 'PicPay PIC PAY',
    );
    eq(await r('pagbank', dele), 'PAGBANK', '§8 pagbank');
    eq(await r('nubank', dele), 'Nubank Crédito', '§8 nubank -> o unico que o contem (era null)');
    eq(await r('picpay', dele), 'PicPay', '§8 picpay -> o exato, nao o "PIC PAY"');
    eq(await r('mercado pago', dele), 'Mercado pago', '§8 exato vence o "Credito"');
    // ⚠️ Estes seguem ambiguos — e e CERTO que sigam: ele tem cinco InfinitePay.
    eq(await r('infinitepay', dele), 'InfinitePay', '§8 "infinitepay" -> o exato');
    eq(await r('vendas', dele), null, '§8 "vendas" casa com 2 -> pergunta');
    eq(await r('afiacao', dele), null, '§8 "afiacao" casa com 2 -> pergunta');
    eq(await r('infinitepay afiação', dele), 'INFINITEPAY  AFIAÇÃO', '§8 nome completo -> a certa (era a ERRADA)');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`x ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('OK resolverCarteira: acha o nome parcial, e NAO decide quando ha duas');
  process.exit(0);
})().catch((e) => { console.error('x erro:', e.message); process.exit(1); });
