// =============================================================================
// EVAL — a descrição do lançamento: como gravar e como mostrar.
//
// Duas sugestões do mesmo cliente (Fábio, 05/10/2026):
//   002 — mostrar a DESCRIÇÃO na confirmação, não só a categoria
//   003 — a descrição "ficar igual à forma que o usuário lançou na mensagem"
//
// ⚠️ A 003 NÃO É CAPITALIZAR A INICIAL. Capitalizar daria "Corrida de uber", e
// o exemplo do cliente tem DUAS maiúsculas. O que a Sora fazia era
// MINUSCULIZAR — `interpretarRapido` abre com `message.toLowerCase()`, e a
// descrição é uma fatia desse texto.
//
// Rodar: node evals/descricaoTx.eval.js
// =============================================================================
const { grafiaOriginal, linhaDescricao, inicialMaiuscula, chave } = require('../src/services/descricaoTx');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

console.log('-- 1. a grafia que a pessoa escreveu volta inteira --');
{
  // O caso EXATO do relato.
  eq(grafiaOriginal('corrida de uber', 'Gastei 25 com Corrida de Uber'), 'Corrida de Uber', '1 o caso do cliente');
  eq(grafiaOriginal('mensalidade da academia', 'Paguei 150 de Mensalidade da Academia'),
     'Mensalidade da Academia', '1 tres palavras');
  eq(grafiaOriginal('whey', 'Comprei um Whey por 150'), 'Whey', '1 uma palavra');
  eq(grafiaOriginal('netflix', 'assinei a Netflix 39,90'), 'Netflix', '1 marca');
  // Caixa alta de verdade e preservada.
  eq(grafiaOriginal('ipva', 'paguei 800 de IPVA'), 'IPVA', '1 sigla em caixa alta');
}
console.log('  ok');

console.log('-- 2. ACENTO volta, e e por isso que a busca e por chave --');
{
  // ⚠️ A descricao sai do texto JA normalizado pelo interpretador, que remove
  // acento. Procurar "refeicao" num original que diz "refeição" com
  // `toLowerCase()` simples falharia — e a pessoa receberia a confirmacao com
  // a palavra errada.
  eq(grafiaOriginal('refeicao', 'Gastei 30 com Refeição'), 'Refeição', '2 acento volta');
  eq(grafiaOriginal('acougue', 'gastei 60 no Açougue'), 'Açougue', '2 cedilha');
  eq(grafiaOriginal('pao de queijo', 'comprei Pão de Queijo'), 'Pão de Queijo', '2 til');
}
console.log('  ok');

console.log('-- 3. descricao que NAO veio do texto ganha a inicial --');
{
  // A IA resume: "50 no ze delivery" -> observacao "bebida". Nao ha o que
  // recuperar, e a inicial maiuscula ja e o que o cliente pediu nesse caso.
  eq(grafiaOriginal('bebida', '50 no zé delivery'), 'Bebida', '3 inventada pela IA');
  eq(grafiaOriginal('salario', 'recebi 2000'), 'Salario', '3 sem o termo no texto');
  // Tudo minusculo de verdade: so a inicial sobe.
  eq(grafiaOriginal('corrida de uber', 'gastei 25 com corrida de uber'), 'Corrida de uber', '3 minusculo vira inicial');
}
console.log('  ok');

console.log('-- 4. entradas degeneradas nao estouram --');
{
  eq(grafiaOriginal('', 'gastei 40'), '', '4 vazio');
  eq(grafiaOriginal(null, 'gastei 40'), '', '4 null');
  eq(grafiaOriginal(undefined, undefined), '', '4 tudo undefined');
  eq(grafiaOriginal('mercado', null), 'Mercado', '4 sem original');
  eq(grafiaOriginal('mercado', ''), 'Mercado', '4 original vazio');
  eq(grafiaOriginal('  mercado  ', 'no Mercado'), 'Mercado', '4 apara espaco');
  eq(inicialMaiuscula(''), '', '4 inicial de vazio');
}
console.log('  ok');

console.log('-- 5. a linha so aparece quando INFORMA algo --');
{
  // Sugestao 002.
  eq(linhaDescricao('Corrida de Uber', '🚗 Transporte'), '📝 Descrição: Corrida de Uber', '5 aparece');
  eq(linhaDescricao('Feira', 'Supermercado'), '📝 Descrição: Feira', '5 aparece');

  // ⚠️ NAO REPETE A CATEGORIA. Em "uber 18" a descricao e "uber" e a categoria
  // e "Uber": a linha nao informaria nada e so alongaria a confirmacao.
  eq(linhaDescricao('uber', 'Uber'), null, '5 igual a categoria -> some');
  eq(linhaDescricao('Uber', '🚕 Uber'), null, '5 com emoji na categoria -> some');
  eq(linhaDescricao('alimentacao', '🍔 Alimentação'), null, '5 com acento -> some');
  eq(linhaDescricao('', 'Outros'), null, '5 vazia -> some');
  eq(linhaDescricao(null, 'Outros'), null, '5 null -> some');
}
console.log('  ok');

console.log('-- 6. a comparacao nao pode ser ampla demais --');
{
  // ⚠️ O risco do outro lado: esconder descricao que o cliente QUER ver.
  // "Mercado Livre" nao e "Mercado"; "Uber Eats" nao e "Uber".
  eq(linhaDescricao('Mercado Livre', 'Supermercado'), '📝 Descrição: Mercado Livre', '6 nome maior aparece');
  eq(linhaDescricao('Uber Eats', '🚕 Uber'), '📝 Descrição: Uber Eats', '6 idem');
  eq(linhaDescricao('Almoço', '🍔 Alimentação'), '📝 Descrição: Almoço', '6 item dentro do balde');
}
console.log('  ok');

console.log('-- 7. texto COLADO com acento combinante --');
{
  // ⚠️ ACHADO PELA MUTACAO: as duas guardas do recorte (comprimento igual e
  // "a fatia bate com o alvo") pareciam redundancia defensiva, porque em
  // texto digitado normalmente `chave` devolve 1 caractere por letra. Mas
  // texto COLADO de alguns sistemas vem com o acento SEPARADO da letra
  // (e + U+0301 em vez de é): ai o original tem 2 caracteres onde a chave
  // tem 1, os indices deixam de valer, e sem as guardas o recorte sairia
  // deslocado — a pessoa receberia a confirmacao com a palavra cortada.
  const E_COMBINANTE = String.fromCharCode(101, 769);   // "e" + acento = é
  const colado = 'Gastei 25 com Caf' + E_COMBINANTE + ' da esquina';

  const r = grafiaOriginal('cafe da esquina', colado);

  // ⚠️ A ASSERCAO QUE FALTAVA, e a mutacao mostrou: eu checava so que o
  // resultado COMECAVA com "Caf", e um recorte truncado tambem comeca assim.
  // Medido, com e sem as guardas:
  //
  //     com as guardas .... "Cafe da esquina"   (completo, sem o acento)
  //     sem as guardas .... "Café da esquin"    (CORTADO — falta o "a")
  //
  // O corte acontece porque os indices do texto normalizado nao valem no
  // original quando o acento vem separado: a chave tem 1 caractere onde o
  // original tem 2, e a fatia sai um caractere curta. "Café da esquin" na
  // confirmacao parece defeito da Sora.
  ok(r.endsWith('esquina'), '7 a ULTIMA palavra sai inteira, nao cortada: ' + JSON.stringify(r));
  eq(r[0], 'C', '7 e com a inicial maiuscula');

  // ⚠️ As duas guardas sao redes para o MESMO buraco: cada uma sozinha
  // cobre este caso, entao remover UMA nao muda nada. Remover as DUAS corta
  // a palavra — e e isso que esta asserção trava.

  // E o caminho normal (acento JUNTO da letra) segue recuperando tudo.
  eq(grafiaOriginal('cafe da esquina', 'Gastei 25 com Café da Esquina'),
     'Café da Esquina', '7 com acento normal, recupera inteiro');
}
console.log('  ok');

console.log('-- 8. so esconde a linha quando e IGUAL, nunca quando CABE --');
{
  // ⚠️ ACHADO PELA MUTACAO: trocar a igualdade por "a categoria contem a
  // descricao" passava nos meus casos, porque todos tinham a descricao MAIOR
  // que a categoria. O perigo esta na direcao oposta — e ai a Sora esconderia
  // informacao que o cliente quer ver.
  eq(linhaDescricao('Uber', '🚕 Uber Eats'), '📝 Descrição: Uber', '8 descricao DENTRO da categoria aparece');
  eq(linhaDescricao('Mercado', '🛒 Mercado Livre'), '📝 Descrição: Mercado', '8 idem');
  eq(linhaDescricao('Conta', '💡 Conta de Luz'), '📝 Descrição: Conta', '8 idem');

  // E o contrario tambem continua aparecendo (ja estava no §6).
  eq(linhaDescricao('Uber Eats', '🚕 Uber'), '📝 Descrição: Uber Eats', '8 descricao maior aparece');

  // So some quando sao a MESMA coisa.
  eq(linhaDescricao('Uber Eats', '🚕 Uber Eats'), null, '8 igual some');
}
console.log('  ok');

console.log('-- 9. a chave TEM de tirar o acento --');
{
  // Sem isso, "refeicao" (como o interpretador entrega) nunca acharia
  // "Refeição" no original, e a confirmacao sairia sem o acento.
  eq(chave('Refeição'), 'refeicao', '9 tira acento e baixa a caixa');
  eq(chave('AÇOUGUE'), 'acougue', '9 cedilha');
  eq(chave('Pão'), 'pao', '9 til');
  eq(chave(null), '', '9 null');
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK descricaoTx: a grafia volta inteira e a linha so aparece quando informa');
process.exit(0);
