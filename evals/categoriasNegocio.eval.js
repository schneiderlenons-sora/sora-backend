// =============================================================================
// EVAL — categorias PRÓPRIAS do Sora Negócios (regra pura, migration 196).
//
// O que trava:
//   1. "a mesma categoria" = mesma chave (sem acento, caixa, espaço);
//   2. categoria própria não colide com a lista padrão (valor OU rótulo);
//   3. a lista junta as guardadas + as já digitadas, com o nome certo e o uso;
//   4. grafias diferentes da mesma categoria são achadas (pra cascata);
//   5. ícone fora da lista fechada e natureza inválida são recusados;
//   6. a natureza das guardadas chega ao DRE por chave.
//
// Rodar: npm run eval:categorias-negocio
// =============================================================================
const c = require('../src/services/categoriasNegocio');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`); };

console.log('§1 chave');
eq(c.chave('  Conveniência  '), 'conveniencia', 'acento, caixa e espaço');
eq(c.chave('CONVENIENCIA'), c.chave('Conveniência'), 'mesma categoria');
eq(c.chave('Lanche   da tarde'), 'lanche da tarde', 'espaço repetido');
eq(c.chave('uso_pessoal'), 'uso pessoal', 'underline vira espaço');
eq(c.chave(null), '', 'nulo');

console.log('§2 nome');
eq(c.validarNome('saida', '  Sistema   de Controle '), { nome: 'Sistema de Controle' }, 'limpa espaços');
eq(c.validarNome('saida', 'Aluguel').erro, 'Essa categoria já existe na lista padrão.', 'colide com rótulo padrão');
eq(c.validarNome('saida', 'aluguel').erro, 'Essa categoria já existe na lista padrão.', 'colide com o valor padrão');
eq(c.validarNome('saida', 'Funcionarios').erro, 'Essa categoria já existe na lista padrão.', 'rótulo sem acento');
eq(c.validarNome('saida', 'Uso pessoal').erro, 'Essa categoria já existe na lista padrão.', 'valor com underline');
eq(c.validarNome('entrada', 'Outras receitas').erro, 'Essa categoria já existe na lista padrão.', 'rótulo de entrada');
eq(c.validarNome('entrada', 'Outros').erro, 'Essa categoria já existe na lista padrão.', 'valor "outros" na entrada');
eq(c.validarNome('entrada', 'Aluguel recebido'), { nome: 'Aluguel recebido' }, 'parecido não é igual');
eq(c.validarNome('entrada', 'Aluguel'), { nome: 'Aluguel' }, '"Aluguel" é padrão só na SAÍDA');
eq(c.validarNome('saida', 'A classificar').erro, 'Essa categoria já existe na lista padrão.', 'marca do sistema é reservada');
eq(c.validarNome('saida', '').erro, 'Dê um nome à categoria.', 'vazio');
eq(c.validarNome('saida', '---').erro, 'Use letras ou números no nome.', 'só símbolo');
eq(c.validarNome('saida', 'x'.repeat(31)).erro, 'Use até 30 letras no nome.', 'longo demais');
eq(c.validarNome('saida', 'x'.repeat(30)).nome.length, 30, '30 cabe');
eq(c.validarNome('outro', 'Padaria').erro, 'Tipo inválido.', 'tipo inválido');
eq(c.valorFixa('saida', 'Luz / Água'), 'energia', 'rótulo → valor gravado');
eq(c.valorFixa('saida', 'fornecedor'), 'fornecedor', 'valor → valor');
eq(c.valorFixa('saida', 'a_classificar'), null, 'reservada não é destino');
eq(c.valorFixa('saida', 'Padaria'), null, 'própria não é fixa');

console.log('§3 lista');
const registradas = [
  { id: 'r1', tipo: 'saida', nome: 'Conveniência', icone: 'Store', natureza: 'fixa', oculta: false },
  { id: 'r2', tipo: 'saida', nome: 'Sem uso', icone: null, natureza: null, oculta: false },
  { id: 'r3', tipo: 'entrada', nome: 'Rendimentos', icone: 'TrendingUp', natureza: 'fixa', oculta: true },
];
const lancamentos = [
  { tipo: 'saida', categoria: 'CONVENIENCIA' }, { tipo: 'saida', categoria: 'CONVENIENCIA' },
  { tipo: 'saida', categoria: 'Conveniencia' },
  { tipo: 'saida', categoria: 'COVENIENCIA' },
  { tipo: 'saida', categoria: 'Sistema de Controle' }, { tipo: 'saida', categoria: 'Sistema de Controle' },
  { tipo: 'saida', categoria: 'aluguel' }, { tipo: 'saida', categoria: 'a_classificar' },
  { tipo: 'saida', categoria: 'movimentacao' }, { tipo: 'saida', categoria: null },
  { tipo: 'entrada', categoria: 'Rendimentos' }, { tipo: 'entrada', categoria: 'vendas' },
  { tipo: 'saida', categoria: 'Rendimentos' },
];
const lista = c.montarLista({ registradas, lancamentos });
const achar = (tipo, nome) => lista.find((x) => x.tipo === tipo && x.chave === c.chave(nome));
eq(lista.map((x) => `${x.tipo}:${x.nome}`),
  ['entrada:Rendimentos', 'saida:Conveniência', 'saida:COVENIENCIA', 'saida:Rendimentos', 'saida:Sem uso', 'saida:Sistema de Controle'],
  'entradas primeiro, depois saídas, em ordem alfabética; fixas e marcas fora');
const conv = achar('saida', 'conveniencia');
eq([conv.nome, conv.icone, conv.natureza, conv.registrada, conv.usos], ['Conveniência', 'Store', 'fixa', true, 3],
  'guardada: nome guardado vence as grafias digitadas; usos somam as grafias');
eq(conv.grafias, ['CONVENIENCIA', 'Conveniencia'], 'grafias que a cascata vai acertar');
eq([achar('saida', 'covenIENCIA').registrada, achar('saida', 'covenIENCIA').usos], [false, 1],
  'erro de digitação é OUTRA categoria (resolve-se com Juntar)');
const sis = achar('saida', 'sistema de controle');
eq([sis.nome, sis.icone, sis.registrada, sis.usos], ['Sistema de Controle', null, false, 2], 'só digitada: aparece pra reaproveitar, sem ícone');
eq([achar('saida', 'sem uso').usos, achar('saida', 'sem uso').registrada], [0, true], 'guardada sem uso aparece com 0');
eq([achar('entrada', 'rendimentos').oculta, achar('entrada', 'rendimentos').natureza], [true, null],
  'oculta vem marcada; entrada nunca tem natureza');
eq(!!achar('saida', 'rendimentos'), true, 'mesmo nome em outro tipo é outra categoria');
// Grafia exibida sem guardada: a mais usada; empate decidido de forma estável.
const g1 = c.montarLista({ lancamentos: [{ tipo: 'saida', categoria: 'padaria' }, { tipo: 'saida', categoria: 'Padaria' }] })[0].nome;
const g2 = c.montarLista({ lancamentos: [{ tipo: 'saida', categoria: 'Padaria' }, { tipo: 'saida', categoria: 'padaria' }] })[0].nome;
eq(g1, g2, 'empate não depende da ordem do banco');
eq(c.montarLista({ lancamentos: [{ tipo: 'saida', categoria: 'BEBIDAS' }, { tipo: 'saida', categoria: 'Bebidas' }, { tipo: 'saida', categoria: 'Bebidas' }] })[0].nome,
  'Bebidas', 'a grafia mais usada vence');
eq(c.montarLista({}), [], 'vazio');

console.log('§4 variantes');
eq(c.variantes('Conveniência', ['CONVENIENCIA', 'Conveniencia', 'COVENIENCIA', 'Conveniência', 'aluguel', null]).sort(),
  ['CONVENIENCIA', 'Conveniencia', 'Conveniência'], 'todas as grafias da mesma chave, sem o erro de digitação');
eq(c.variantes('Padaria', []), [], 'nenhuma');

console.log('§5 ícone e natureza');
eq(c.iconeValido('Store'), 'Store', 'ícone da lista');
eq(c.iconeValido(null), null, 'sem ícone');
eq(c.iconeValido(''), null, 'vazio = sem ícone');
eq(c.iconeValido('Skull'), undefined, 'fora da lista é recusado');
eq(c.iconeValido('store'), undefined, 'caixa errada é recusada (vira componente)');
eq(c.naturezaValida('saida', 'fixa'), 'fixa', 'fixa');
eq(c.naturezaValida('saida', 'variavel'), 'variavel', 'variável');
eq(c.naturezaValida('saida', 'mensal'), undefined, 'inválida');
eq(c.naturezaValida('entrada', 'fixa'), null, 'entrada ignora natureza');
eq(c.ICONES.length, new Set(c.ICONES).size, 'sem ícone repetido');

console.log('§6 natureza pro DRE');
const m = c.naturezaPorChave(registradas);
eq([m.get('conveniencia'), m.has('sem uso'), m.has('rendimentos')], ['fixa', false, false],
  'só saída com natureza escolhida');
const lanc = [
  { tipo: 'saida', categoria: 'CONVENIENCIA', valor: 10 },                       // própria fixa (outra grafia)
  { tipo: 'saida', categoria: 'Conveniência', valor: 10, natureza: 'variavel' },  // escolhida no lançamento vence
  { tipo: 'saida', categoria: 'Sem uso', valor: 10 },                            // própria sem natureza
  { tipo: 'saida', categoria: 'aluguel', valor: 10 },                            // padrão: fica pro mapa do DRE
  { tipo: 'entrada', categoria: 'Conveniência', valor: 10 },                     // entrada não tem natureza
  { tipo: 'saida', categoria: null, valor: 10 },
];
eq(c.aplicarNatureza(lanc, registradas).map((l) => l.natureza ?? null), ['fixa', 'variavel', null, null, null, null],
  'DRE: própria fixa vira fixa; a escolha do lançamento vence; o resto intacto');
eq(c.aplicarNatureza(lanc, []), lanc, 'sem categoria guardada: mesma lista');
const dre = require('../src/services/dre').montarDre({ lancamentos: c.aplicarNatureza(
  [{ tipo: 'entrada', categoria: 'vendas', valor: 1000 }, { tipo: 'saida', categoria: 'CONVENIENCIA', valor: 300 }], registradas) });
eq([dre.despesas_fixas, dre.despesas_variaveis], [300, 0], 'DRE de verdade: a própria fixa cai em despesas FIXAS');

console.log(`\n${total - falhas.length}/${total} ok`);
if (falhas.length) { console.log('\nFALHAS:\n - ' + falhas.join('\n - ')); process.exit(1); }
