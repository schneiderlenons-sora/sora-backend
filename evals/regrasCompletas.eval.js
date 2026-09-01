// =============================================================================
// EVAL das regras completas (migration 146): categorizar, renomear, recorrente
// e "não considerar".
//
// A seção 1 é a mais importante: REGRA ANTIGA NÃO PODE MUDAR DE COMPORTAMENTO.
// O motor roda em TODA importação (OFX + 3 syncs de Open Finance + WhatsApp), e
// uma mudança de semântica aqui recategoriza silenciosamente o histórico de
// quem já tinha regra.
//
// A seção 5 protege dinheiro: "não considerar" tem dois escopos e eles NÃO são
// a mesma coisa — 'fluxo' sai das somas e FICA na fatura; 'tudo' sai dos dois.
// Trocar isso faz a fatura da Sora divergir da do banco.
//
// Rodar:  npm run eval:regras-completas
// =============================================================================
const R = require('../src/services/regrasCategoria');
const { ehTransferencia } = require('../src/services/resumoTransacoes');
const { valorNaFatura } = require('../src/services/valorFatura');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} — deu ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`); };

// Monta uma regra já normalizada, como `carregarRegras` devolve.
const regra = (o) => ({
  termo: R.normalizar(o.termo),
  tipo: o.tipo || 'categorizar',
  modo_match: o.modo_match || 'contem',
  categoria: o.categoria || null,
  renomear_para: o.renomear_para || null,
  recorrente: o.recorrente === true,
  ignorar_escopo: o.ignorar_escopo || 'tudo',
});

// ── 1. REGRA ANTIGA NÃO MUDA ───────────────────────────────────────────────
console.log('── 1. compatibilidade com a regra antiga ──');
{
  // Uma regra de antes da 146 vem sem os campos novos; os defaults têm de
  // reproduzir exatamente o que ela fazia: categorizar, casando por "contém"
  // nos DOIS sentidos.
  const antiga = regra({ termo: 'fernandopeixoto', categoria: 'Barbeiro' });
  eq(antiga.tipo, 'categorizar', 'default do tipo');
  eq(antiga.modo_match, 'contem', 'default do match');

  ok(R.casaRegra(R.normalizar('PIX FERNANDOPEIXOTO 0512'), antiga), 'descrição contém o termo');
  ok(R.casaRegra(R.normalizar('FernandoPeixoto'), antiga), 'descrição igual ao termo');
  // O sentido inverso (termo contém a descrição) é a semântica histórica.
  const longa = regra({ termo: 'clinica sao lucas central', categoria: 'Consultas' });
  ok(R.casaRegra(R.normalizar('clinica sao lucas'), longa), 'termo contém a descrição (histórico)');

  const linha = { observacao: 'PIX FERNANDOPEIXOTO', categoria: 'Outros' };
  ok(R.aplicarNaLinha(linha, antiga), 'aplicou');
  eq(linha.categoria, 'Barbeiro', 'categoria trocada');
  eq(linha.observacao, 'PIX FERNANDOPEIXOTO', 'nome NÃO muda sem renomear_para');
  eq(linha.ignorar_em, undefined, 'regra de categorizar não carimba ignorar_em');
}
console.log('  ok');

// ── 2. Texto exato × Contém ────────────────────────────────────────────────
console.log('── 2. exato × contém ──');
{
  const exata = regra({ termo: 'PAGAMENTO DEBITO AUTOMATICO', modo_match: 'exato', tipo: 'ignorar' });
  ok(R.casaRegra(R.normalizar('Pagamento Debito Automatico'), exata), 'exato ignora caixa');
  ok(R.casaRegra(R.normalizar('PAGAMENTO DÉBITO AUTOMÁTICO'), exata), 'exato ignora acento');
  ok(!R.casaRegra(R.normalizar('PAGAMENTO DEBITO AUTOMATICO FATURA'), exata),
     'exato NÃO casa quando sobra texto — é a diferença pro contém');

  const contem = regra({ ...exata, modo_match: 'contem' });
  ok(R.casaRegra(R.normalizar('PAGAMENTO DEBITO AUTOMATICO FATURA'), contem), 'contém casa com texto a mais');
}
console.log('  ok');

// ── 3. Categorizar: renomear e recorrente ──────────────────────────────────
console.log('── 3. renomear e recorrente ──');
{
  const r = regra({ termo: 'ott grafica', categoria: 'Casa', renomear_para: 'Gráfica do bairro', recorrente: true });
  const linha = { observacao: 'OTT GRAFICA LTDA 0912', categoria: 'Outros' };
  ok(R.aplicarNaLinha(linha, r), 'aplicou');
  eq(linha.categoria, 'Casa', 'categoria');
  eq(linha.observacao, 'Gráfica do bairro', 'renomeada');
  eq(linha.recorrente, true, 'marcada como recorrente');

  // Regra SÓ de renomear (sem categoria) é válida — o print traz categoria e
  // renome como campos independentes.
  const soNome = regra({ termo: 'ec veloxingressos', renomear_para: 'Velox Ingressos' });
  const l2 = { observacao: 'EC*VELOXINGRESSOS', categoria: 'Cinema' };
  ok(R.aplicarNaLinha(l2, soNome), 'aplicou só o nome');
  eq(l2.categoria, 'Cinema', 'categoria intocada quando a regra não define uma');
  eq(l2.observacao, 'Velox Ingressos', 'renomeada');

  // Idempotência: aplicar de novo não "muda" nada.
  ok(!R.aplicarNaLinha(l2, soNome), 'reaplicar não conta como mudança');
}
console.log('  ok');

// ── 4. Não considerar ──────────────────────────────────────────────────────
console.log('── 4. não considerar ──');
{
  const tudo = regra({ termo: 'pagamento fatura', tipo: 'ignorar', ignorar_escopo: 'tudo' });
  const l1 = { observacao: 'PAGAMENTO FATURA CARTAO', categoria: 'Fatura', valor: 100, tipo: 'Gasto' };
  ok(R.aplicarNaLinha(l1, tudo), 'aplicou');
  eq(l1.ignorar_em, 'tudo', 'carimbou o escopo');
  eq(l1.categoria, 'Fatura', 'ignorar NÃO mexe na categoria');
  eq(l1.observacao, 'PAGAMENTO FATURA CARTAO', 'ignorar NÃO renomeia');

  const fluxo = regra({ termo: 'anuidade', tipo: 'ignorar', ignorar_escopo: 'fluxo' });
  const l2 = { observacao: 'ANUIDADE CARTAO', categoria: 'Financeiro' };
  R.aplicarNaLinha(l2, fluxo);
  eq(l2.ignorar_em, 'fluxo', 'escopo fluxo');

  // ⚠️ Regra de ignorar não pode virar categorização no caminho do WhatsApp.
  eq(tudo.categoria, null, 'regra de ignorar não tem categoria');
}
console.log('  ok');

// ── 5. O DINHEIRO: os dois escopos NÃO são iguais ──────────────────────────
// ⚠️ Seção que protege a fatura. 'fluxo' sai das somas e FICA na fatura;
// 'tudo' sai dos dois. Igualar os dois faria a fatura divergir da do banco.
console.log('── 5. escopo × somas × fatura ──');
{
  // Somas (receita/despesa): os DOIS escopos saem.
  ok(ehTransferencia({ ignorar_em: 'tudo',  tipo: 'Gasto', categoria: 'Mercado' }), "'tudo' sai das somas");
  ok(ehTransferencia({ ignorar_em: 'fluxo', tipo: 'Gasto', categoria: 'Mercado' }), "'fluxo' sai das somas");
  ok(!ehTransferencia({ tipo: 'Gasto', categoria: 'Mercado' }), 'linha normal continua contando');

  // Fatura: SÓ 'tudo' sai.
  eq(valorNaFatura({ tipo: 'Gasto', valor: 100, ignorar_em: 'tudo' }), 0, "'tudo' sai da fatura");
  eq(valorNaFatura({ tipo: 'Gasto', valor: 100, ignorar_em: 'fluxo' }), 100,
     "⚠️ 'fluxo' CONTINUA na fatura — é o sentido de 'só na despesa/receita'");
  eq(valorNaFatura({ tipo: 'Gasto', valor: 100 }), 100, 'linha normal na fatura');

  // E o crédito que abate continua abatendo quando não é ignorado.
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 40, transferencia: true, categoria: 'Reembolso' }), -40,
     'estorno segue abatendo');
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 40, transferencia: true, categoria: 'Reembolso', ignorar_em: 'tudo' }), 0,
     'estorno ignorado não abate');
}
console.log('  ok');

// ── 6. O TEXTO DO USUÁRIO NÃO PODE SER MUTILADO ────────────────────────────
// ⚠️ A razão de existir do campo "bruto". `termoDe` tira ruído de maquininha
// ("pix", "compra", "pagamento", "debito"…) — ótimo pra regra nascida de uma
// correção, DESTRUTIVO pras frases de fatura que o usuário digita.
console.log('── 6. texto digitado × termo extraído ──');
{
  const frase = 'PAGAMENTO DEBITO AUTOMATICO';
  const extraido = R.termoDe(frase);
  const digitado = R.normalizar(frase);

  eq(digitado, 'pagamento debito automatico', 'texto do usuário fica inteiro');
  ok(extraido !== digitado, 'termoDe REALMENTE mutila esta frase — por isso `bruto` existe');
  ok(!extraido.includes('pagamento'), `termoDe removeu "pagamento" (deu "${extraido}")`);

  // E a regra digitada casa com o que o banco manda.
  const r = regra({ termo: frase, tipo: 'ignorar', modo_match: 'contem' });
  ok(R.casaRegra(R.normalizar('PAGAMENTO DEBITO AUTOMATICO 08/09'), r), 'casa a linha real do banco');
}
console.log('  ok');

// ── 7. Ordem entre regras ──────────────────────────────────────────────────
console.log('── 7. precedência ──');
{
  // Reproduz a ordenação de `carregarRegras`.
  const ordenar = (rs) => [...rs].sort((a, b) => {
    if (a.modo_match !== b.modo_match) return a.modo_match === 'exato' ? -1 : 1;
    return b.termo.length - a.termo.length;
  });

  const generica = regra({ termo: 'clinica', categoria: 'Saúde' });
  const especifica = regra({ termo: 'clinica sao lucas', categoria: 'Consultas' });
  eq(ordenar([generica, especifica])[0].categoria, 'Consultas', 'termo mais longo primeiro');

  const exata = regra({ termo: 'uber', modo_match: 'exato', categoria: 'Uber' });
  const contem = regra({ termo: 'uber eats delivery', categoria: 'Delivery' });
  eq(ordenar([contem, exata])[0].categoria, 'Uber',
     'exato vence contém, mesmo com termo mais curto');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ regras completas: tudo passou.');
