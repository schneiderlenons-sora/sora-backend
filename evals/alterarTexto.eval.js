// =============================================================================
// EVAL — o detector de "altera a transação X".
//
// ⚠️ OS VERBOS DAQUI SÃO OS MAIS COMUNS DO IDIOMA (altera/muda/corrige/edita/
// troca/ajusta). Este projeto já pagou caro por duas regras amplas demais — a
// de "gasto" e a de "relatório" —, que sequestravam QUALQUER frase com a
// palavra e nunca chegavam na IA. Por isso metade deste eval é a lista do que
// NÃO pode ser reivindicado.
//
// ⚠️ MEDIDO ANTES DE ESCREVER (07/10/2026): das 8 frases de alteração, 7
// caíam na IA e morriam lá, e `"corrige o último lançamento para 80"` era
// sequestrada por `alterar_saldo` — a Sora ia acertar o saldo de uma conta
// chamada "último lançamento".
//
// Rodar: node evals/alterarTexto.eval.js
// =============================================================================
const { detectarAlteracao, mudancasDaFrase, alvoDaFrase } = require('../src/services/alterarTexto');
const { interpretarRapido } = require('../src/handlers/interpretador');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

console.log('-- 1. as frases que DEVEM virar alteracao --');
{
  const casos = [
    ['altera a transação ab12cd para 50',            'AB12CD', { valor: 50 }],
    ['muda o valor da transação ab12cd pra 80',      'AB12CD', { valor: 80 }],
    ['corrige a transação ab12cd categoria Mercado', 'AB12CD', { categoria: 'Mercado' }],
    ['altera ab12cd descrição Corrida de Uber',      'AB12CD', { descricao: 'Corrida de Uber' }],
    ['muda a transação ab12cd pra conta Nubank',     'AB12CD', { conta: 'Nubank' }],
    ['editar transação ab12cd',                      'AB12CD', {}],
    ['quero alterar a transação ab12cd para 99,90',  'AB12CD', { valor: 99.9 }],
    ['altera ab12cd data 05/10',                     'AB12CD', { data: '2026-10-05' }],
    ['altera a última transação pra 50',             null,     { valor: 50 }],
    ['corrige o último lançamento para 80',          null,     { valor: 80 }],
  ];
  for (const [frase, id, mud] of casos) {
    const r = detectarAlteracao(frase);
    ok(!!r, `1 nao detectou: "${frase}"`);
    if (!r) continue;
    eq(r.idCurto, id, `1 id de "${frase}"`);
    eq(JSON.stringify(r.mudancas), JSON.stringify(mud), `1 mudancas de "${frase}"`);
  }
}
console.log('  ok');

console.log('-- 2. as frases que NAO podem ser reivindicadas --');
{
  // ⚠️ CADA UMA TEM REGRA PROPRIA no interpretador. Roubar qualquer uma delas
  // quebra um caminho que ja funciona — e foi exatamente assim que os dois
  // catch-all anteriores nasceram.
  const naoDeve = [
    'última foi do nubank',                 // corrigir_ultima_carteira
    'alterar saldo do nubank para 500',     // saldo
    'ajustar nubank 850',                   // saldo
    'ajusta o saldo do inter pra 300',      // saldo
    'mude meu saldo do nubank pra 2000',    // saldo
    'quero mudar meu plano',                // cancelar/plano
    'alterar a categoria do mercado livre', // regra de categoria
    'muda o vencimento da fatura pro dia 10',
    'muda a data de fechamento do cartao',
    'altera o limite do nubank',
    'excluir transação ab12cd',             // apagar
    'gastei 50 no mercado',                 // salvar
    'corrige o nome da conta',
    'altera a última',                      // alvo ambiguo: conta? meta? divida?
    'muda minha senha',
    'altera meu email',
    'altera a meta de viagem pra 5000',
    'corrige a dívida do carro',
    'o mercado mudou de nome',              // verbo NO MEIO, nao no comeco
    'mudar o lembrete da conta de luz',
    'altera a recorrencia da internet',
    'corrige meu investimento',
  ];
  for (const f of naoDeve) {
    const r = detectarAlteracao(f);
    eq(r, null, `2 SEQUESTROU "${f}" -> ${JSON.stringify(r)}`);
  }
}
console.log('  ok');

console.log('-- 3. o alvo: id com digito, nunca palavra comum --');
{
  // ⚠️ Um id curto mistura letras E digitos. Sem exigir o digito, "mercado",
  // "padaria", "nubank" e "cartao" (6 letras) virariam id — e a Sora
  // procuraria uma transacao que nao existe.
  eq(alvoDaFrase('altera a transacao ab12cd pra 50')?.idCurto, 'AB12CD', '3 pega o id');
  eq(alvoDaFrase('altera a transacao do mercado'), null, '3 "mercado" NAO e id');
  eq(alvoDaFrase('altera a transacao da padaria'), null, '3 "padaria" NAO e id');
  eq(alvoDaFrase('altera a transacao do nubank'), null, '3 "nubank" NAO e id');
  eq(alvoDaFrase('altera 123456 pra 50'), null, '3 so digito NAO e id');
  // "ultima" vence o id (a pessoa disse qual quer).
  ok(alvoDaFrase('altera a ultima transacao')?.ultima, '3 ultima');
  // ⚠️ O ULTIMO id da frase, nao o primeiro: "altera" tem 6 letras.
  eq(alvoDaFrase('altera xy99zz pra 50')?.idCurto, 'XY99ZZ', '3 pega o id certo');
}
console.log('  ok');

console.log('-- 4. a GRAFIA do que a pessoa escreveu e preservada --');
{
  // Sugestao 003 do mesmo cliente: "Corrida de Uber", nao "corrida de uber".
  eq(mudancasDaFrase('altera ab12cd descrição Corrida de Uber').descricao, 'Corrida de Uber', '4 maiusculas');
  eq(mudancasDaFrase('altera ab12cd categoria Alimentação').categoria, 'Alimentação', '4 acento');
  eq(mudancasDaFrase('altera ab12cd conta Mercado Pago').conta, 'Mercado Pago', '4 duas palavras');
  // Pontuacao final nao entra na descricao.
  eq(mudancasDaFrase('altera ab12cd descrição Feira da semana.').descricao, 'Feira da semana', '4 tira o ponto');
}
console.log('  ok');

console.log('-- 5. campo NOMEADO vence o valor solto no fim --');
{
  // ⚠️ "categoria 123" tem numero no fim. Sem a guarda, a frase mudaria valor
  // E categoria de uma vez — e a pessoa so pediu uma coisa.
  const r = mudancasDaFrase('altera ab12cd categoria 123');
  eq(r.categoria, '123', '5 a categoria pega');
  eq(r.valor, undefined, '5 e o valor NAO');

  const d = mudancasDaFrase('altera ab12cd descrição Uber 50');
  eq(d.descricao, 'Uber 50', '5 descricao com numero fica inteira');
  eq(d.valor, undefined, '5 e nao vira valor');
}
console.log('  ok');

console.log('-- 6. formatos de valor --');
{
  eq(mudancasDaFrase('altera ab12cd para 50').valor, 50, '6 inteiro');
  eq(mudancasDaFrase('altera ab12cd para 99,90').valor, 99.9, '6 virgula decimal');
  eq(mudancasDaFrase('altera ab12cd para R$ 1.250,00').valor, 1250, '6 milhar + R$');
  eq(mudancasDaFrase('altera ab12cd valor 80').valor, 80, '6 "valor N"');
  // ⚠️ Zero e negativo nao sao valores validos de transacao.
  eq(mudancasDaFrase('altera ab12cd para 0').valor, undefined, '6 zero nao passa');
}
console.log('  ok');

console.log('-- 7. ponta a ponta pelo interpretador, sem regressao --');
{
  // O detector so vale se estiver LIGADO e na ordem certa.
  eq(interpretarRapido('altera a transação ab12cd para 50')?.acao, 'alterar_tx', '7 ligado');
  // ⚠️ E a regra de saldo logo abaixo continua intacta — era ela que
  // sequestrava a frase de alteracao, entao a ordem importa nos DOIS sentidos.
  eq(interpretarRapido('ajusta o saldo do inter pra 300')?.acao, 'alterar_saldo', '7 saldo intacto');
  eq(interpretarRapido('ajustar nubank 850')?.acao, 'alterar_saldo', '7 ajustar conta intacto');
  eq(interpretarRapido('mude meu saldo do nubank pra 2000')?.acao, 'alterar_saldo', '7 mude saldo intacto');
  eq(interpretarRapido('excluir transação ab12cd')?.acao, 'apagar', '7 apagar intacto');
  eq(interpretarRapido('gastei 50 no mercado')?.acao, 'salvar', '7 salvar intacto');
  // E o caso que era sequestrado agora vai pro lugar certo.
  eq(interpretarRapido('corrige o último lançamento para 80')?.acao, 'alterar_tx', '7 o sequestro acabou');
}
console.log('  ok');

console.log('-- 8. as GUARDAS so importam quando a frase TEM alvo --');
{
  // ⚠️ A MUTACAO MOSTROU QUE EU NAO ESTAVA TESTANDO ISTO. Remover as
  // guardas de saldo/limite/meta nao quebrava nada, porque as frases que eu
  // usava ("ajustar nubank 850") morrem antes, na falta de alvo. A guarda
  // so entra em acao quando a frase aponta uma transacao E fala de outra
  // coisa — e ai ela e o que impede o sequestro.
  const comAlvo = [
    'ajusta o saldo da última transação',
    'altera o saldo da transação ab12cd',
    'corrige o limite da transação ab12cd',
    'altera o vencimento da transação ab12cd',
    'muda a meta da última transação',
    'altera a dívida da transação ab12cd',
    'corrige o lembrete da última transação',
    'altera a senha da transação ab12cd',
  ];
  for (const f of comAlvo) {
    eq(detectarAlteracao(f), null, `8 guarda falhou em "${f}"`);
  }
  // E a prova de que o alvo existe nelas: tirando a palavra que a guarda
  // barra, a MESMA frase passa a ser detectada.
  ok(!!detectarAlteracao('altera a transação ab12cd'), '8 a mesma frase SEM a palavra barrada passa');
}
console.log('  ok');

console.log('-- 9. com DOIS ids na frase, vale o ULTIMO --');
{
  // ⚠️ O id fica no fim. Pegar o primeiro acha a transacao errada — e,
  // pior, acha UMA (existe), entao a Sora alteraria com confianca a linha
  // que a pessoa nao pediu.
  eq(alvoDaFrase('altera ab12cd pra xy99zz')?.idCurto, 'XY99ZZ', '9 o ultimo id');
  eq(alvoDaFrase('troca aa11bb por cc22dd')?.idCurto, 'CC22DD', '9 idem');
}
console.log('  ok');

console.log('-- 10. VERBO no meio da frase nao conta, mesmo com alvo --');
{
  // Relato nao e comando. "a transacao ab12cd mudou sozinha" e uma queixa;
  // vira-la em alteracao faria a Sora abrir um formulario no meio de um
  // desabafo — e, com campo citado, ALTERAR de verdade.
  eq(detectarAlteracao('a transação ab12cd mudou sozinha'), null, '10 queixa nao e comando');
  eq(detectarAlteracao('a transação ab12cd mudou para 50'), null, '10 nem com valor');
  eq(detectarAlteracao('vi que o lançamento ab12cd trocou de conta'), null, '10 relato');
  // Mas o verbo DEPOIS de "quero/preciso" continua valendo.
  ok(!!detectarAlteracao('quero alterar a transação ab12cd para 50'), '10 quero+verbo vale');
  ok(!!detectarAlteracao('preciso corrigir a transação ab12cd'), '10 preciso+verbo vale');
}
console.log('  ok');

console.log('-- 11. VALOR explicito convive com outro campo --');
{
  // ⚠️ ACHADO PELA MUTACAO: a guarda antiga bloqueava o valor sempre que
  // havia campo nomeado, e "altera ab12cd valor 80 categoria Mercado"
  // perdia o 80 EM SILENCIO — mudava so a categoria e confirmava as duas.
  const r = mudancasDaFrase('altera ab12cd valor 80 categoria Mercado');
  eq(r.valor, 80, '11 o valor explicito entra');
  eq(r.categoria, 'Mercado', '11 e a categoria tambem');

  // O implicito continua cedendo ao campo nomeado.
  eq(mudancasDaFrase('altera ab12cd categoria 123').valor, undefined, '11 "categoria 123" nao e valor');
  eq(mudancasDaFrase('altera ab12cd descrição Uber 50').valor, undefined, '11 numero na descricao nao e valor');
}
console.log('  ok');
console.log('-- 12. NEGACAO nao vira comando --');
{
  // ⚠️ ACHADO PELA MUTACAO, e e o caso que mais importa da ancora: os
  // meus exemplos de "verbo no meio" usavam formas conjugadas ("mudou",
  // "alterou") que o regex nem casa — entao tirar a ancora nao quebrava
  // nada. A frase que REALMENTE depende dela e a NEGACAO: sem ancora,
  // "nao altera a transacao ab12cd" vira um comando de alterar, que e o
  // oposto exato do que a pessoa pediu.
  eq(detectarAlteracao('não altera a transação ab12cd'), null, '12 "nao altera" NAO e alterar');
  eq(detectarAlteracao('não mude a transação ab12cd'), null, '12 "nao mude" idem');
  eq(detectarAlteracao('nao mexe na transação ab12cd'), null, '12 "nao mexe" idem');
  eq(detectarAlteracao('por favor não corrige a transação ab12cd'), null, '12 com "por favor"');
  // E a mesma frase SEM a negacao continua valendo.
  ok(!!detectarAlteracao('altera a transação ab12cd'), '12 sem negacao, passa');
}
console.log('  ok');

console.log('-- 13. campo nomeado ENGOLE o "para N" do fim --');
{
  // ⚠️ ACHADO PELA MUTACAO: o meu caso anterior ("categoria 123") nao
  // tinha "para" nenhum, entao o 2o regex nem disparava e a guarda ficava
  // sem teste. Aqui ele dispara de verdade.
  //
  // "categoria Uber para 50": o "para 50" faz parte do NOME que a pessoa
  // escreveu. Sem a guarda, a Sora mudaria a categoria E o valor — um
  // lancamento de R$ 50 que ninguem pediu.
  const r = mudancasDaFrase('altera ab12cd categoria Uber para 50');
  eq(r.valor, undefined, '13 o "para 50" NAO vira valor');
  eq(r.categoria, 'Uber para 50', '13 fica inteiro na categoria');

  // Idem na descricao e na conta.
  eq(mudancasDaFrase('altera ab12cd descrição Corrida para 50').valor, undefined, '13 descricao');
  eq(mudancasDaFrase('altera ab12cd conta Caixa para 50').valor, undefined, '13 conta');

  // E sem campo nomeado o "para 50" volta a ser valor.
  eq(mudancasDaFrase('altera ab12cd para 50').valor, 50, '13 sem campo nomeado, e valor');
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK alterarTexto: pega as frases de alteracao e NAO rouba as 22 vizinhas');
process.exit(0);
