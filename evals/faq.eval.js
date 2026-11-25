// =============================================================================
// EVAL: respostas prontas do WhatsApp (services/faq.js + data/faq.js).
//
// O FAQ roda DEPOIS do leitor de comandos e ANTES da IA. Resposta pronta que
// casa com a mensagem errada ROUBA a mensagem: a IA nunca a vê.
//
// Caso real (nov/2026, cliente vitalícia): "Mensalidade da IA cobrou no
// crédito NuBank agora no valor de 107,54" recebeu a TABELA DE PREÇOS (o
// gatilho era a palavra "mensalidade" solta) e o gasto nunca foi lançado; "Já
// lançou a mensalidade da IA?" recebeu a tabela de novo. O que este eval trava:
//   1. mensagem sobre o dinheiro da pessoa (valor com centavos, R$, "cobrou",
//      "debitou", "já lançou?") NÃO recebe resposta pronta;
//   2. "mensalidade" da academia/escola/plano de saúde não é pergunta de preço;
//   3. as perguntas de preço continuam respondidas;
//   4. "quanto e" não casa com o começo de "quanto eu…";
//   5. as outras respostas prontas seguem respondendo (regressão).
//
// Rodar:  npm run eval:faq
// =============================================================================
const { responderFaq } = require('../src/services/faq');
const { FAQ } = require('../src/data/faq');

const falhas = [];
let total = 0;
const idDe = (resp) => (resp ? (FAQ.find((f) => f.resposta === resp) || { id: '?' }).id : null);
const eq = (frase, esperado, nota) => {
  total++;
  const veio = idDe(responderFaq(frase));
  if (veio !== esperado) falhas.push(`${nota || JSON.stringify(frase)}\n     esperado ${esperado}, veio ${veio}`);
};

console.log('── 1. ⚠️ mensagem sobre o dinheiro da pessoa não recebe resposta pronta ──');
eq('Mensalidade da IA cobrou no crédito NuBank agora no valor de 107,54', null, 'o caso real: gasto com "mensalidade" e valor');
eq('Já lançou a mensalidade dA IA ?', null, 'o caso real: pergunta se lançou');
eq('netflix cobrou 55,90 no cartão', null, 'valor com centavos');
eq('R$ 49 da academia', null, 'valor com R$');
eq('debitaram a mensalidade da escola hoje', null, '"debitaram"');
eq('a mensalidade da academia descontou no nubank', null, '"descontou"');
eq('você registrou meu gasto do mercado?', null, '"registrou"');
eq('cobraram a mensalidade do premium duas vezes', null, 'reclamação de cobrança não recebe a tabela de preços');
eq('seguro do carro 1.250,00', null, 'valor com milhar e centavos não cai em "segurança"');

console.log('── 2. "mensalidade" de outra coisa não é pergunta de preço ──');
eq('mensalidade da academia', null);
eq('mensalidade do plano de saúde venceu', null, '"plano de saúde" não é o plano da Sora');
eq('a mensalidade da faculdade atrasou', null);

console.log('── 3. perguntas de preço continuam respondidas ──');
for (const f of ['quanto custa a sora?', 'qual a mensalidade?', 'qual o valor da mensalidade?', 'quanto é a mensalidade', 'valor da mensalidade',
  'mensalidade da sora', 'qual a mensalidade do premium', 'quais os planos', 'qual o preço?', 'quanto fica por mês?', 'planos e valores']) {
  eq(f, 'precos-planos');
}

console.log('── 4. "quanto e" não casa com "quanto eu…" ──');
eq('quanto eu devo pro joão', null, '"quanto eu" não é "quanto é"');

console.log('── 5. as outras respostas prontas seguem iguais ──');
const REGRESSAO = [
  ['o que a sora faz?', 'o-que-e'],
  ['como eu registro um gasto', 'registrar-gasto'],
  ['posso mandar audio?', 'audio'],
  ['foto da comida da macro?', 'foto-comida-macros'],
  ['posso mandar foto da nota fiscal?', 'foto-pdf-ocr'],
  ['de qual conta saiu?', 'conta-padrao'],
  ['tem aplicativo pra instalar?', 'instalar-app'],
  ['como eu vinculo meu whatsapp', 'vincular-whatsapp'],
  ['troquei de numero', 'trocar-numero'],
  ['quem ve meus dados', 'privacidade-numero'],
  ['qual a diferença entre os planos', 'diferenca-planos'],
  ['como eu assino?', 'como-assinar'],
  ['tem teste gratis?', 'teste-gratis'],
  ['como eu cancelo', 'cancelar'],
  ['tem plano anual?', 'anual-desconto'],
  ['quero trocar o cartao', 'trocar-cartao'],
  ['como acesso o painel', 'acessar-painel'],
  ['pra que serve o painel', 'painel-vs-whatsapp'],
  ['como crio uma conta', 'criar-conta-cartao'],
  ['qual meu saldo', 'ver-saldo'],
  ['como funciona a fatura', 'cartao-fatura'],
  ['como cadastro uma divida', 'dividas-parcelas'],
  ['como defino uma meta', 'metas-limites'],
  ['como funciona investimentos', 'investimentos'],
  ['como importar extrato', 'importar-ofx'],
  ['quero usar com minha esposa', 'compartilhar-familia'],
  ['o que é o grow', 'o-que-e-grow'],
  ['como crio um habito', 'habito'],
  ['me lembra de ligar pro joão', 'lembrete-agenda'],
  ['ativar resumo semanal', 'resumos'],
  ['meus dados estão seguros?', 'seguranca'],
  ['preciso de ajuda', 'suporte-bug'],
];
for (const [f, id] of REGRESSAO) eq(f, id);
eq('gastei 50 no mercado', null, 'lançamento com verbo segue fora do FAQ');
eq('oi', null, 'curta demais');

console.log(`\n${total - falhas.length}/${total} verificações passaram`);
if (falhas.length) {
  console.error('\n✗ FALHAS:\n  ' + falhas.join('\n  '));
  process.exit(1);
}
console.log('✓ eval:faq ok');
