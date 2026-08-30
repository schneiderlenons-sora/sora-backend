// =============================================================================
// EVAL das marcas/radicais adicionados a pedido do usuário (ago/2026).
//
// Todas nasceram de lançamento REAL que caiu errado no painel de um cliente.
// O número ao lado de cada caso é o que foi medido na base ANTES da correção.
//
// A seção 2 é a que importa de verdade: são as linhas que uma keyword nova
// poderia roubar. O erro caro aqui não é "a marca não casou" — é uma regra
// gulosa arrastar TRANSFERÊNCIA ou PIX pra dentro de despesa, porque aí o
// dinheiro passa a ser contado como gasto e o resumo do mês mente.
//
// Rodar:  npm run eval:marcas-br
// =============================================================================
const { categorizar } = require('../src/services/categorizar');

const falhas = [];
const cat = (d, ehGasto = true) => categorizar({ descricao: d, ehGasto });
const eq = (d, esperado, nota) => {
  const teve = cat(d);
  if (teve !== esperado) falhas.push(`"${d}" => ${teve} (esperado ${esperado})${nota ? ' — ' + nota : ''}`);
};

// ── 1. As marcas pedidas ───────────────────────────────────────────────────
console.log('── 1. marcas pedidas ──');
{
  // Me Leva — app de corrida. 9 lançamentos, 7 parados em Outros.
  // As duas grafias existem porque a fatura trunca de jeitos diferentes.
  eq('Me Leva BQ', 'Uber');
  eq('Me Leva Bq*Meleva', 'Uber');

  // ClickBus — 5 lançamentos espalhados por Outros, Transporte e Ônibus.
  // ⚠️ "BUS SERVICOS*CLIC" é o caso que prova por que 'bus servicos' precisa
  // existir junto de 'clickbus': truncado, o nome da marca some.
  eq('ClickBus', 'Ônibus');
  eq('Bus Servicos*Clickbus', 'Ônibus');
  eq('BUS SERVICOS*CLIC', 'Ônibus');

  // Veloc Tickets — 0 na base; regra pedida pra frente.
  eq('Veloc Tickets', 'Cinema');
  eq('VELOC TICK', 'Cinema', 'truncado — é por isso que a keyword é o radical');

  // Body Laser — 6 lançamentos, em Consultas, Outros e Higiene Pessoal.
  // ⚠️ "Vindi" é o gateway de cobrança; a clínica vem depois do '*'.
  eq('Body Laser', 'Higiene Pessoal');
  eq('BodyLaser', 'Higiene Pessoal');
  eq('Vindi *Bodylaserbarba', 'Higiene Pessoal');

  // Academias. "Contorno do Corpo Barb" e "Dellas Fitness" estavam em Outros.
  eq('Contorno do Corpo Barb', 'Academia');
  eq('Sportfit', 'Academia');
  eq('SmartFit', 'Academia');
  eq('Dellas Fitness 1/3', 'Academia');
  eq('Panobianco Academia', 'Academia');

  // Alimentação pelo RADICAL: o descritor trunca a palavra.
  eq('Superfoods Alimentaca', 'Alimentação', 'sem o "o" final — o caso que originou a regra');
  eq('RJPRODUTOSALIMENT', 'Alimentação');
  eq('Compra débito MacamoAlimentos', 'Alimentação');
}
console.log('  ok');

// ── 2. O que as regras novas NÃO podem roubar ──────────────────────────────
// ⚠️ ESTA É A SEÇÃO QUE PROTEGE DINHEIRO. Cada caso aqui é uma linha real da
// base que uma das keywords novas casaria se a ORDEM das regras mudasse.
console.log('── 2. regressões que as keywords novas poderiam causar ──');
{
  // O radical 'aliment' está DEPOIS de PIX/Transferências de propósito. Se
  // subir, estas duas viram despesa de comida e saem da conta de transferência.
  eq('Transferência enviada|AMM X COMERCIO DE ALIMENTOS', 'Transferências');
  eq('Pagamento de Pix QR Code ARCOS DOURADOS COMERCIO ALIMENTOS', 'Pix enviado');

  // O prefixo do adquirente continua mandando mais que o nome da loja.
  eq('Ifd*Superfoods Aliment', 'iFood');
  eq('IFD*MN ALIMENTOS LTDA', 'iFood');

  // Dieta vem ANTES de Alimentação — suplemento não é refeição.
  eq('Suplementos', 'Dieta');
  eq('Suplemento Alimentar Whey', 'Dieta');

  // As subcategorias específicas de comida vencem o guarda-chuva.
  eq('Padaria Alimentos Ltda', 'Padaria');
  eq('Supermercado Alimentos', 'Supermercado');

  // 'veloc' (Cinema) × 'veloe' (Pedágio): uma letra separa as duas.
  eq('Sem Parar Veloe', 'Pedágio');

  // Higiene Pessoal está antes de Barbeiro/Salão, mas não pode engolir os dois.
  eq('Barbearia do Ze', 'Barbeiro');
  eq('Salao de beleza Depilacao', 'Salão de beleza');

  // 'me leva' não pode virar curinga de frase solta.
  eq('Uber *Trip', 'Uber');

  // Lazer continua existindo — só o cinema saiu de lá.
  eq('Sympla Ingresso Show', 'Lazer');
  eq('Teatro Municipal', 'Lazer');
}
console.log('  ok');

// ── 3. Ônibus não pode ser guloso ──────────────────────────────────────────
// ⚠️ 'bus' solto casaria "busca"/"Buscapé"; 'rodoviaria' solto casaria
// "Polícia Rodoviária Federal", que é MULTA, não passagem. Por isso as
// keywords são frases inteiras. Estes casos travam essa decisão.
console.log('── 3. Ônibus com keyword estreita ──');
{
  const naoEhOnibus = [
    'Buscape Comparador',
    'MULTA POLICIA RODOVIARIA FEDERAL',
    'Busca Vida Resort',
  ];
  for (const d of naoEhOnibus) {
    if (cat(d) === 'Ônibus') falhas.push(`"${d}" virou Ônibus — a keyword ficou gulosa`);
  }
  // E o que É passagem continua casando.
  eq('Passagem rodoviaria Itapemirim', 'Ônibus');
  eq('Buser viagem', 'Ônibus');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Marcas BR (transporte, academia, higiene, alimentação): tudo passou.');
