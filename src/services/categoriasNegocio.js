// =============================================================================
// Categorias PRÓPRIAS do Sora Negócios (migration 196).
//
// Pedido de cliente (nov/2026): "não tem como colocar mais categorias… queria
// também colocar um ícone". O formulário já aceitava uma categoria digitada
// ("Outra"), mas ela não ficava guardada: medido em 15/11/2026, 7 das 15
// empresas que lançam no caixa digitavam a sua — "Sistema de Controle" 7 vezes,
// e a MESMA conveniência escrita de três jeitos ("CONVENIENCIA",
// "Conveniencia", "COVENIENCIA").
//
// ⚠️ O VALOR GRAVADO NO LANÇAMENTO É O NOME, NÃO UM ID. `lancamentos_negocio.
// categoria` sempre foi texto livre e o que o "Outra" grava é o próprio nome.
// Manter isso faz DRE, Painel, CSV e regras aprendidas mostrarem a categoria
// nova SEM mudar uma linha deles, e faz tudo que já foi digitado virar
// categoria reaproveitável na hora. O preço é o do `carteira_nome` das contas:
// RENOMEAR TEM DE CASCATEAR (lançamentos + regras aprendidas) — está em
// `routes/negocios.js`, e o eval de rota trava.
//
// ⚠️ "A mesma categoria" = mesma CHAVE (sem acento, sem caixa, espaço único):
// "CONVENIENCIA" e "Conveniência" são uma só. "COVENIENCIA" (erro de digitação)
// é outra — essa se resolve com "Juntar" na tela.
//
// Travado em `npm run eval:categorias-negocio` (+ `-rota`).
// =============================================================================

/** As categorias FIXAS do painel. Espelho de `lib/lancamentos.ts` (o eval do
 *  front compara os dois). Servem só pra nenhuma categoria própria colidir
 *  com uma delas — "Aluguel" próprio ao lado do "Aluguel" padrão dividiria o
 *  mesmo gasto em duas linhas do DRE e perderia a natureza "fixa". */
const FIXAS = {
  entrada: [
    { v: 'vendas', label: 'Vendas' },
    { v: 'servicos', label: 'Serviços' },
    { v: 'outros', label: 'Outras receitas' },
    { v: 'movimentacao', label: 'Movimentação entre contas' },
  ],
  saida: [
    { v: 'fornecedor', label: 'Fornecedor' },
    { v: 'aluguel', label: 'Aluguel' },
    { v: 'energia', label: 'Luz / Água' },
    { v: 'internet', label: 'Internet' },
    { v: 'folha', label: 'Funcionários' },
    { v: 'impostos', label: 'Impostos' },
    { v: 'manutencao', label: 'Manutenção' },
    { v: 'marketing', label: 'Marketing' },
    { v: 'transporte', label: 'Transporte' },
    { v: 'outros', label: 'Outros' },
    { v: 'movimentacao', label: 'Movimentação entre contas' },
    { v: 'uso_pessoal', label: 'Uso pessoal / retirada do sócio' },
  ],
};

/** Marcas do sistema que não são categoria de ninguém. */
const RESERVADAS = ['a_classificar', 'a classificar', 'sem categoria'];

const TIPOS = ['entrada', 'saida'];
const NATUREZAS = ['fixa', 'variavel'];
const NOME_MAX = 30;

/** Ícones que a pessoa pode escolher (nomes do Lucide). Lista FECHADA: o nome
 *  vira componente no painel, e um nome solto não teria o que desenhar.
 *  Espelho de `components/negocios/IconeCategoria.tsx` (o eval do front compara). */
const ICONES = [
  'ShoppingBag', 'ShoppingCart', 'Store', 'Package', 'Boxes', 'Truck', 'Tag', 'Receipt',
  'Home', 'Building2', 'Factory', 'Zap', 'Droplets', 'Flame', 'Wifi', 'Phone',
  'Users', 'UserRound', 'Briefcase', 'Wrench', 'Hammer', 'Scissors', 'Sparkles', 'Paintbrush',
  'Landmark', 'Banknote', 'CreditCard', 'Wallet', 'PiggyBank', 'HandCoins', 'TrendingUp', 'Calculator',
  'Utensils', 'Coffee', 'Pizza', 'Croissant', 'Beer', 'Car', 'Fuel', 'Bike',
  'Plane', 'Laptop', 'Code', 'Cloud', 'Megaphone', 'Printer', 'FileText', 'Shirt',
  'HeartPulse', 'Pill', 'GraduationCap', 'Gift', 'Dog', 'Leaf', 'Shield', 'Dumbbell',
];

/** Chave de comparação: sem acento, sem caixa, espaços colapsados. */
function chave(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

/** Nome limpo como a pessoa escreveu (só tira espaço sobrando). */
const limpar = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** É uma das fixas (pelo valor gravado OU pelo rótulo da tela) ou reservada? */
function ehFixa(tipo, nome) {
  const k = chave(nome);
  if (!k) return false;
  if (RESERVADAS.some((r) => chave(r) === k)) return true;
  return (FIXAS[tipo] || []).some((c) => chave(c.v) === k || chave(c.label) === k);
}

/** Valor gravado de uma fixa (`'aluguel'`) a partir do valor OU do rótulo. */
function valorFixa(tipo, nome) {
  const k = chave(nome);
  const c = (FIXAS[tipo] || []).find((x) => chave(x.v) === k || chave(x.label) === k);
  return c ? c.v : null;
}

/**
 * Valida o nome de uma categoria própria.
 * @returns {{ nome: string } | { erro: string }}
 */
function validarNome(tipo, nome) {
  if (!TIPOS.includes(tipo)) return { erro: 'Tipo inválido.' };
  const n = limpar(nome);
  if (!n) return { erro: 'Dê um nome à categoria.' };
  if (n.length > NOME_MAX) return { erro: `Use até ${NOME_MAX} letras no nome.` };
  if (!/[\p{L}\p{N}]/u.test(n)) return { erro: 'Use letras ou números no nome.' };
  if (ehFixa(tipo, n)) return { erro: 'Essa categoria já existe na lista padrão.' };
  return { nome: n };
}

const iconeValido = (i) => (i == null || i === '' ? null : ICONES.includes(i) ? i : undefined);
const naturezaValida = (tipo, n) => (tipo !== 'saida' || n == null || n === '' ? null
  : NATUREZAS.includes(n) ? n : undefined);

/**
 * A lista que o painel mostra: as categorias guardadas + as que já foram
 * digitadas em algum lançamento (pelo "Outra") e ainda não foram guardadas.
 *
 * @param {object} p
 * @param {Array<{id,tipo,nome,icone,natureza,oculta}>} p.registradas
 * @param {Array<{tipo,categoria}>} p.lancamentos  só tipo + categoria
 * @returns {Array<{tipo,nome,chave,icone,natureza,oculta,registrada,usos,grafias}>}
 */
function montarLista({ registradas = [], lancamentos = [] } = {}) {
  const grupos = new Map();
  const grupo = (tipo, k) => {
    const id = `${tipo}|${k}`;
    if (!grupos.has(id)) grupos.set(id, { tipo, chave: k, reg: null, grafias: new Map(), usos: 0 });
    return grupos.get(id);
  };
  for (const r of registradas) {
    if (!TIPOS.includes(r.tipo)) continue;
    const k = chave(r.nome);
    if (!k) continue;
    const g = grupo(r.tipo, k);
    if (!g.reg) g.reg = r;
  }
  for (const l of lancamentos) {
    if (!TIPOS.includes(l.tipo) || !l.categoria) continue;
    if (ehFixa(l.tipo, l.categoria)) continue;
    const k = chave(l.categoria);
    if (!k) continue;
    const g = grupo(l.tipo, k);
    g.usos += 1;
    g.grafias.set(l.categoria, (g.grafias.get(l.categoria) || 0) + 1);
  }
  const lista = [];
  for (const g of grupos.values()) {
    // Nome exibido: o guardado; sem ele, a grafia mais usada (empate: ordem
    // alfabética, pra não depender da ordem em que o banco devolveu).
    let nome = g.reg ? limpar(g.reg.nome) : null;
    if (!nome) {
      let melhor = -1;
      for (const [gr, n] of g.grafias) {
        if (n > melhor || (n === melhor && gr.localeCompare(nome, 'pt-BR') < 0)) { nome = gr; melhor = n; }
      }
      nome = limpar(nome);
    }
    lista.push({
      tipo: g.tipo,
      nome,
      chave: g.chave,
      icone: g.reg?.icone || null,
      natureza: g.tipo === 'saida' ? (g.reg?.natureza || null) : null,
      oculta: !!g.reg?.oculta,
      registrada: !!g.reg,
      usos: g.usos,
      grafias: [...g.grafias.keys()].sort(),
    });
  }
  return lista.sort((a, b) => (a.tipo !== b.tipo ? (a.tipo === 'entrada' ? -1 : 1)
    : a.nome.localeCompare(b.nome, 'pt-BR')));
}

/** Os textos EXATOS gravados que são a mesma categoria de `nome`. */
function variantes(nome, existentes = []) {
  const k = chave(nome);
  return [...new Set(existentes.filter((e) => e && chave(e) === k))];
}

/** Natureza (fixa/variável) das categorias de SAÍDA guardadas, por chave. */
function naturezaPorChave(registradas = []) {
  const m = new Map();
  for (const r of registradas) {
    if (r.tipo === 'saida' && NATUREZAS.includes(r.natureza)) m.set(chave(r.nome), r.natureza);
  }
  return m;
}

/**
 * Lançamentos do DRE com a natureza da categoria própria aplicada. A natureza
 * escolhida NO lançamento vence; entrada e categoria padrão não mudam (a
 * padrão já tem a sua em `NATUREZA_PADRAO` do services/dre.js).
 */
function aplicarNatureza(lancamentos = [], registradas = []) {
  const mapa = naturezaPorChave(registradas);
  if (!mapa.size) return lancamentos;
  return lancamentos.map((l) => {
    if (l.natureza || l.tipo !== 'saida' || !l.categoria) return l;
    const n = mapa.get(chave(l.categoria));
    return n ? { ...l, natureza: n } : l;
  });
}

module.exports = {
  FIXAS, RESERVADAS, TIPOS, NATUREZAS, NOME_MAX, ICONES,
  chave, limpar, ehFixa, valorFixa, validarNome, iconeValido, naturezaValida,
  montarLista, variantes, naturezaPorChave, aplicarNatureza,
};
