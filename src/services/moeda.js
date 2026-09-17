// =============================================================================
// Moeda da carteira — aritmética canônica.
//
// ESPELHADO em sora-frontend/lib/moeda.ts (só a parte de catálogo/formatação;
// a conversão é sempre feita AQUI e enviada pronta pro painel). Mexeu num,
// mexa no outro e rode `npm run eval:moeda`.
//
// ── AS DUAS REGRAS QUE NÃO PODEM REGREDIR ───────────────────────────────────
//
// 1. `wallets.saldo` é NATIVO. Uma conta Nomad com US$ 6.834,56 guarda 6834.56.
//    Esse número é um FATO e não pode variar com o câmbio. O equivalente na
//    moeda base é DERIVADO (`saldoNaBase`) e esse sim muda todo dia — o certo.
//
// 2. `transacoes.valor` está SEMPRE NA MOEDA BASE DO GRUPO (`grupos.moeda_base`,
//    migration 168), congelado na entrada. Até a 168 a base era fixa em real, e
//    é por isso que as migrations 144/160 dizem "SEMPRE BRL" — para os grupos em
//    real continua sendo verdade. É o que mantém dashboard, categorias,
//    relatórios, limites, Wrapped e Oráculo corretos sem nenhuma alteração
//    neles: um grupo nunca mistura bases. Converter na hora de exibir faria o
//    "gasto de março" mudar todo dia junto com o câmbio.
//
// ⚠️ A INVARIANTE DAS COLUNAS DE MOEDA DA TRANSAÇÃO: `moeda` NULL = a linha está
// na base do grupo; `moeda` preenchida = foi lançada numa conta de OUTRA moeda,
// com o nativo em `valor_moeda` e a taxa usada em `taxa_brl`. ⚠️ O nome da
// coluna é histórico: ela guarda a taxa da moeda da conta PARA A BASE (que em
// grupo em real é, de fato, a taxa em BRL). Medido em 17/09/2026: nenhuma linha
// de `transacoes` ou `recorrencias` tem `moeda = 'BRL'`.
//
// ⚠️ FALHA DE CÂMBIO NUNCA VIRA ZERO. Se a cotação não vier (Yahoo fora do ar,
// rede caindo), `taxas()` devolve o que tiver em cache e a conversão devolve
// `null` — nunca 0. Somar 0 apagaria o dinheiro do cliente da tela sem avisar,
// que é infinitamente pior do que mostrar "câmbio indisponível".
// =============================================================================
const { taxaParaBRLDetalhe } = require('./cotacoes');
const supabase = require('../db/supabase');

const PADRAO = 'BRL';

// Moedas oferecidas no seletor. Lista curta de propósito: são as que aparecem
// em conta internacional de brasileiro. Acrescentar é só somar aqui.
const MOEDAS = {
  BRL: { nome: 'Real',            simbolo: 'R$',  locale: 'pt-BR' },
  USD: { nome: 'Dólar americano', simbolo: 'US$', locale: 'en-US' },
  EUR: { nome: 'Euro',            simbolo: '€',   locale: 'de-DE' },
  GBP: { nome: 'Libra',           simbolo: '£',   locale: 'en-GB' },
  CHF: { nome: 'Franco suíço',    simbolo: 'CHF', locale: 'de-CH' },
  CAD: { nome: 'Dólar canadense', simbolo: 'C$',  locale: 'en-CA' },
  AUD: { nome: 'Dólar australiano', simbolo: 'A$', locale: 'en-AU' },
  JPY: { nome: 'Iene',            simbolo: '¥',   locale: 'ja-JP', casas: 0 },
  ARS: { nome: 'Peso argentino',  simbolo: 'AR$', locale: 'es-AR' },
  MXN: { nome: 'Peso mexicano',   simbolo: 'MX$', locale: 'es-MX' },
  // ⚠️ `casas: 0` — o peso chileno NÃO usa centavos. No Chile escreve-se
  //    $1.250, nunca $1.250,00.
  //
  //    ⚠️ E o `locale` NÃO resolve isso sozinho: o `formatar` abaixo usa
  //    sempre pt-BR (o leitor é brasileiro) e fixava 2 casas pra todo mundo.
  //    Cheguei a escrever aqui que o locale resolvia — não resolve, e só
  //    apareceu quando formatei um valor de verdade. O IENE tinha o mesmo
  //    defeito desde sempre (¥ 1.250,00, que não existe) e foi junto.
  CLP: { nome: 'Peso chileno',    simbolo: 'CLP$', locale: 'es-CL', casas: 0 },
  NOK: { nome: 'Coroa norueguesa', simbolo: 'kr', locale: 'nb-NO' },
};

/**
 * Normaliza o código da moeda. Vazio/desconhecido → 'BRL'.
 * ⚠️ É aqui que mora a validação, e NÃO num CHECK do banco: três incidentes
 * desta base (users_plano_check, investimentos_tipo_check, dividas_tipo_check)
 * foram gravação falhando calada por causa de CHECK.
 */
function normalizarMoeda(m) {
  const s = String(m || '').trim().toUpperCase();
  return MOEDAS[s] ? s : PADRAO;
}

/**
 * A carteira/valor está numa moeda diferente da base do grupo?
 * Sem `base`, compara com o real — o comportamento de antes da migration 168.
 */
function ehEstrangeira(moeda, base = PADRAO) {
  return normalizarMoeda(moeda) !== normalizarMoeda(base);
}

// ── Cache de câmbio ─────────────────────────────────────────────────────────
// Câmbio não muda de minuto a minuto pro que a Sora faz, e cada leitura é uma
// ida ao Yahoo. TTL de 1h; o valor velho é MANTIDO se a busca falhar.
const TTL_MS = 60 * 60 * 1000;
const cache = new Map();   // moeda → { taxa, em }

// ── A última cotação conhecida, PERSISTIDA (migration 159) ────────────────
//
// ⚠️ O cache em memória não sobrevive ao Render free, que HIBERNA: a cada
// cold start o Map volta vazio, e aí toda visita depende de uma chamada
// externa nova dar certo naquele instante. Foi assim que um cliente com
// contas em coroa viu "câmbio indisponível" nos dois saldos.
//
// ⚠️ AS DUAS PONTAS SÃO TOLERANTES. Sem a migration 159 a tabela não existe,
// o erro é engolido e o comportamento é exatamente o de antes — cache só em
// memória. Isto AUMENTA a resiliência, não habilita a feature; é o que
// impede a família de bugs em que a gravação falha calada porque a migration
// não rodou.
async function lerTaxaSalva(m) {
  try {
    const { data } = await supabase.from('cotacoes_moeda')
      .select('taxa_brl').eq('moeda', m).maybeSingle();
    const v = Number(data?.taxa_brl);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

async function salvarTaxa(m, valor, fonte) {
  try {
    await supabase.from('cotacoes_moeda')
      .upsert({ moeda: m, taxa_brl: valor, fonte, atualizado: new Date().toISOString() },
              { onConflict: 'moeda' });
  } catch { /* sem a 159 a tabela não existe — segue com o cache em memória */ }
}

async function taxa(moeda) {
  const m = normalizarMoeda(moeda);
  if (m === PADRAO) return 1;

  const hit = cache.get(m);
  if (hit && Date.now() - hit.em < TTL_MS) return hit.taxa;

  try {
    const { taxa: t, fonte } = await taxaParaBRLDetalhe(m);
    if (t && Number.isFinite(t) && t > 0) {
      cache.set(m, { taxa: t, em: Date.now() });
      // Sem `await`: gravar a rede de segurança não pode atrasar a resposta.
      salvarTaxa(m, t, fonte);
      return t;
    }
  } catch { /* cai nos fallbacks abaixo */ }

  // ⚠️ Cotação falhou. Devolve a ÚLTIMA conhecida, por velha que seja — um
  // número de ontem é muito melhor que sumir com o saldo. Memória primeiro
  // (mais nova), depois o banco, que é quem sobrevive ao restart.
  if (hit) return hit.taxa;
  const salva = await lerTaxaSalva(m);
  if (salva) {
    cache.set(m, { taxa: salva, em: Date.now() });
    return salva;
  }
  // Sem nada: null. Quem chama decide — NUNCA 0, nunca 1.
  return null;
}

/**
 * Taxas de várias moedas de uma vez (uma ida por moeda distinta, em paralelo).
 * Usar SEMPRE que for converter uma lista de carteiras — evita N chamadas.
 */
async function taxas(moedas) {
  const unicas = [...new Set((moedas || []).map(normalizarMoeda))];
  const pares = await Promise.all(unicas.map(async (m) => [m, await taxa(m)]));
  return Object.fromEntries(pares);
}

// ── MOEDA BASE DO GRUPO (migration 168) ─────────────────────────────────────
//
// ⚠️ O REAL DEIXOU DE SER "A MOEDA DO SISTEMA" E VIROU O PIVÔ. `cotacoes_moeda`
// guarda quanto vale 1 unidade de cada moeda EM REAIS — é só isso que as fontes
// externas sabem responder. Qualquer outro par sai de uma divisão:
//
//     USD → NOK  =  (USD→BRL) ÷ (NOK→BRL)  =  5,1435 ÷ 0,5515  =  9,33
//
// Nenhuma tabela nova, nenhuma fonte nova. O BRL passa a ser detalhe de
// implementação em vez de significado — é o que permite um grupo viver em dólar
// ou em coroa sem que o resto do sistema precise saber disso.

/**
 * Taxa pra converter de uma moeda pra outra, via pivô.
 * `tabela` é o mapa moeda → taxa em BRL (o que `taxas()` devolve).
 *
 * ⚠️ Devolve `null` quando falta QUALQUER uma das duas pontas — nunca 1. Cair
 * pra 1 somaria coroa com real na mesma conta, e o número sairia plausível e
 * errado, que é o pior defeito possível aqui.
 */
function taxaEntre(de, para, tabela) {
  const a = normalizarMoeda(de);
  const b = normalizarMoeda(para);
  if (a === b) return 1;

  const emBRL = (m) => (m === PADRAO ? 1 : (tabela ? tabela[m] : null));
  const ta = emBRL(a);
  const tb = emBRL(b);
  if (!ta || !tb || !Number.isFinite(ta) || !Number.isFinite(tb) || tb === 0) return null;
  return ta / tb;
}

/**
 * Converte um valor da moeda nativa pra MOEDA BASE do grupo.
 * Generaliza `paraBRL`: com `base = 'BRL'` o resultado é idêntico.
 */
function paraBase(valor, moeda, base, tabela) {
  const v = Number(valor) || 0;
  const t = taxaEntre(moeda, base, tabela);
  if (t === null) return null;
  return v * t;
}

/**
 * Tabela de câmbio suficiente pra levar `moedas` até a `base`.
 *
 * ⚠️ Sem nada fora da base devolve `{}` SEM ida de rede — é o caminho de quase
 * todo grupo, e é o que `moeda === 'BRL' ? {} : taxas([moeda])` fazia nas
 * rotas. Com algo estrangeiro, busca as moedas E a base: o pivô precisa das
 * duas pontas (em base real a ponta da base é 1 e não custa nada).
 */
async function taxasParaBase(moedas, base = PADRAO) {
  const b = normalizarMoeda(base);
  const fora = (moedas || []).map(normalizarMoeda).filter((m) => m !== b);
  if (!fora.length) return {};
  return taxas([...fora, b]);
}

/**
 * Fator que leva o preço de uma COTAÇÃO DE MERCADO (Yahoo, CoinGecko) — na moeda
 * em que o ativo é negociado — até a moeda base do grupo.
 *
 * ⚠️ A COTAÇÃO ESTRANGEIRA ENTRAVA SEM CONVERSÃO, e isso valia até pra grupo em
 * real: o preço em dólar da Nasdaq era gravado como real. Medido em 17/09/2026
 * nos 170 investimentos com ticker: 37 cotados em real (nada muda), 131 sem
 * cotação e 2 em dólar — um "MELI" (40 cotas) exibido como R$ 73.157,60 a partir
 * de US$ 1.838, que passa a ~R$ 378 mil. Corrigido por decisão do dono.
 *
 * ⚠️ MOEDA FORA DO CATÁLOGO NÃO CONVERTE — devolve `null`. E A CAIXA IMPORTA:
 * o Yahoo cota a bolsa de Londres em "GBp" (PENCE, 1/100 de libra); passar pra
 * maiúsculas a transformaria em "GBP" e o preço sairia 100× maior. Por isso a
 * comparação com o catálogo é feita com a sigla CRUA, sem `normalizarMoeda`
 * (que ainda por cima transformaria sigla desconhecida em BRL).
 *
 * Devolve 1 quando a cotação já está na base, e `null` quando é preciso converter
 * e não há câmbio — quem chama NÃO grava (número plausível e errado é pior que
 * o preço de ontem).
 *
 * `tabela` precisa ter a moeda da cotação e a base: `taxasParaBase([moeda], base)`.
 */
function fatorCotacaoParaBase(moedaCotacao, base, tabela) {
  const b = normalizarMoeda(base);
  const q = String(moedaCotacao || PADRAO).trim();
  if (!MOEDAS[q]) return null;
  if (q === b) return 1;
  return taxaEntre(q, b, tabela);
}

/**
 * O cartão está numa moeda DIFERENTE da base do grupo? (migration 168)
 *
 * Hoje só acontece com cartão do Open Finance (o Open Finance brasileiro só
 * fala real) num grupo em dólar/coroa. Cartão criado à mão nasce na base.
 *
 * ⚠️ GRUPO EM REAL NUNCA BLOQUEIA: devolve false com base BRL, qualquer que seja
 * a moeda do cartão. É o que garante que todo grupo que já existe (todos em
 * real) siga pagando e antecipando exatamente como antes.
 *
 * ⚠️ `moeda` AUSENTE NÃO BLOQUEIA: quem chama TEM de pedir a coluna `moeda` no
 * select — sem ela não há como saber, e bloquear às cegas travaria o pagamento
 * de todo cartão num grupo em dólar.
 */
function cartaoForaDaBase(cartao, base) {
  if (!cartao || cartao.moeda === undefined) return false;
  if (normalizarMoeda(base) === PADRAO) return false;
  return normalizarMoeda(cartao.moeda) !== normalizarMoeda(base);
}

/**
 * Por que o pagamento/antecipação MANUAL desse cartão não é aceito.
 *
 * ⚠️ Travado no MVP (17/09/2026): debitar uma conta pela fatura de um cartão em
 * outra moeda misturaria moedas no saldo e na transação da conta — e o
 * pagamento desse cartão já chega pelo próprio banco
 * (`faturaRollover.registrarPagamentosDoOF`).
 */
function motivoCartaoForaDaBase(cartao, base) {
  const nomeCartao = cartao && cartao.nome ? ` ${cartao.nome}` : '';
  const moedaCartao = MOEDAS[normalizarMoeda(cartao && cartao.moeda)].nome.toLowerCase();
  const moedaGrupo = MOEDAS[normalizarMoeda(base)].nome.toLowerCase();
  // "Chega pelo banco" só é verdade no cartão do Open Finance — pedir
  // `of_conta_id` no select pra ter o texto completo.
  const peloBanco = cartao && cartao.of_conta_id ? 'O pagamento dele chega pelo próprio banco — ' : '';
  return `O cartão${nomeCartao} é em ${moedaCartao} e o seu grupo usa ${moedaGrupo}. `
    + `${peloBanco}${peloBanco ? 'pagar' : 'Pagar'} ou antecipar pela Sora ainda não está `
    + 'disponível nesse caso.';
}

/** Saldo da carteira na moeda base do grupo. `null` sem câmbio — NUNCA 0. */
function saldoNaBase(wallet, base, tabela) {
  return paraBase(wallet?.saldo, wallet?.moeda, base, tabela);
}

/**
 * Lê a moeda base de um grupo.
 *
 * ⚠️ TOLERANTE À MIGRATION 168, com CACHE DE PROCESSO no "a coluna existe?".
 * Sem o cache, uma base sem a migration pagaria uma consulta perdida por
 * chamada. É estado de ESQUEMA, não de usuário — pode ser compartilhado entre
 * requisições sem risco de vazar nada entre clientes.
 *
 * ⚠️ O CACHE EXPIRA EM 10 MINUTOS, não dura o processo inteiro. Com uma flag
 * que nunca volta, o backend que já estava no ar quando a migration rodou
 * seguiria achando que a coluna não existe até o próximo restart — e a moeda
 * escolhida pelo cliente seria ignorada em silêncio. O custo de tentar de novo
 * é uma consulta perdida a cada 10 min, e só enquanto a migration não rodar.
 */
const RETENTAR_BASE_MS = 10 * 60 * 1000;
let baseAusenteAte = 0;
function baseDisponivel() { return Date.now() >= baseAusenteAte; }
function marcarBaseIndisponivel() { baseAusenteAte = Date.now() + RETENTAR_BASE_MS; }

// ⚠️ CACHE POR GRUPO, 10 MINUTOS. A base passa a ser lida em todo lançamento,
// toda lista de contas e todo dashboard — e o egress do Supabase é CONTAGEM de
// requisição (~1,1 KB de cabeçalho cada, ver CLAUDE.md). Sem cache seria uma ida
// a mais por chamada, pra ler um valor que, no MVP, não muda depois do primeiro
// lançamento (a troca é travada — Fase 6 do plano).
//
// ⚠️ QUEM MUDAR A BASE TEM DE CHAMAR `esquecerMoedaBase(grupoId)`. Sem isso,
// esta instância seguiria convertendo pela base antiga por até 10 minutos — e
// um lançamento convertido pra moeda errada não dá tela quebrada, dá número
// plausível e errado, CONGELADO na linha.
//
// ⚠️ FALHA DE LEITURA COM CACHE VELHO USA O VELHO. Cair em BRL num soluço de rede
// converteria o lançamento de um grupo em dólar como se fosse em real.
const TTL_BASE_MS = 10 * 60 * 1000;
const cacheBase = new Map();   // grupoId → { base, em }

function esquecerMoedaBase(grupoId) { cacheBase.delete(grupoId); }

async function moedaBaseDoGrupo(grupoId) {
  if (!grupoId || !baseDisponivel()) return PADRAO;
  const hit = cacheBase.get(grupoId);
  if (hit && Date.now() - hit.em < TTL_BASE_MS) return hit.base;
  try {
    const { data, error } = await supabase.from('grupos')
      .select('moeda_base').eq('id', grupoId).maybeSingle();
    if (error) {
      if (/moeda_base/i.test(error.message || '')) { marcarBaseIndisponivel(); return PADRAO; }
      return hit ? hit.base : PADRAO;
    }
    const base = normalizarMoeda(data?.moeda_base);
    cacheBase.set(grupoId, { base, em: Date.now() });
    return base;
  } catch { return hit ? hit.base : PADRAO; }
}

/**
 * Converte um valor da moeda nativa pra BRL.
 * Devolve `null` quando não há câmbio — NUNCA 0.
 *
 * ⚠️ Caso particular de `paraBase` com base fixa em BRL. Continua existindo
 * porque 13 arquivos a chamam; some quando a Fase 5 do plano migrar todos.
 */
function paraBRL(valor, moeda, tabela) {
  const v = Number(valor) || 0;
  const m = normalizarMoeda(moeda);
  if (m === PADRAO) return v;
  const t = tabela ? tabela[m] : null;
  if (!t || !Number.isFinite(t)) return null;
  return v * t;
}

/**
 * Saldo da carteira convertido pra BRL, pra entrar em soma com as outras.
 *
 * ⚠️ SEM CÂMBIO, DEVOLVE null — e quem soma tem de DECIDIR o que fazer, em vez
 * de receber 0 e achar que somou. `somarSaldos` abaixo é a forma segura.
 */
function saldoEmBRL(wallet, tabela) {
  return paraBRL(wallet?.saldo, wallet?.moeda, tabela);
}

/**
 * Soma o saldo de várias carteiras NA MOEDA BASE, avisando o que não deu pra
 * converter. Sem `base`, soma em real — o comportamento de antes da 168.
 *
 * Devolve `{ total, semCambio }`. `semCambio` > 0 significa que o total está
 * INCOMPLETO — a tela precisa dizer isso, não fingir que o número é final.
 */
function somarSaldos(wallets, tabela, base = PADRAO) {
  let total = 0;
  let semCambio = 0;
  for (const w of wallets || []) {
    const v = saldoNaBase(w, base, tabela);
    if (v === null) { semCambio++; continue; }
    total += v;
  }
  return { total, semCambio };
}

/**
 * Monta os campos de moeda de uma transação nova.
 *
 * `valorNativo` vem na moeda da CARTEIRA. Devolve o que gravar:
 *   · `valor`       → SEMPRE na moeda BASE do grupo (é o que todo o resto soma)
 *   · `valor_moeda` → o nativo, pra tela da conta mostrar a moeda dela
 *   · `taxa_brl`    → a taxa da conta PARA A BASE, congelada agora (o nome da
 *                     coluna é histórico — ver o cabeçalho do arquivo)
 *
 * ⚠️ Conta na moeda da base devolve os três campos NULOS (menos `valor`): a
 * linha fica idêntica ao que já se grava hoje, sem nenhum efeito colateral.
 * Sem `base`, a base é o real — o comportamento de antes da migration 168.
 */
function camposTransacao(valorNativo, moeda, tabela, base = PADRAO) {
  const m = normalizarMoeda(moeda);
  const b = normalizarMoeda(base);
  const v = Number(valorNativo) || 0;
  if (m === b) return { valor: v, moeda: null, valor_moeda: null, taxa_brl: null };

  const t = taxaEntre(m, b, tabela);
  if (t === null) {
    // ⚠️ Sem câmbio, grava o nativo em `valor` com taxa 1 e REGISTRA a moeda.
    // Assim o dinheiro não some da conta do usuário; o número fica provisório e
    // a tela mostra a moeda, deixando claro que não é valor convertido.
    return { valor: v, moeda: m, valor_moeda: v, taxa_brl: null };
  }
  // ⚠️ ARREDONDA NAS CASAS DA BASE. `4090.34 * 0.55032` dá 2250.9959088 em ponto
  //    flutuante; gravar isso põe 7 casas decimais dentro de um campo de
  //    dinheiro e faz somas divergirem por centavos, que é o tipo de erro que o
  //    cliente confere na mão e não perdoa. A TAXA fica inteira (é ela que
  //    reproduz a conta depois); só o resultado é arredondado. Em real (e em
  //    dólar e coroa) a escala é 100 — a MESMA conta de antes, operação por
  //    operação; em iene seria 1.
  const escala = 10 ** (MOEDAS[b].casas ?? 2);
  return {
    valor: Math.round(v * t * escala) / escala,   // na base, congelado
    moeda: m,
    valor_moeda: v,        // nativo
    taxa_brl: t,
  };
}

/**
 * Formata um valor NA MOEDA DELE, pro texto do WhatsApp.
 * Ex.: (6834.56, 'USD') → "US$ 6.834,56" · (10, 'BRL') → "R$ 10,00"
 *
 * ⚠️ Usa sempre a grafia pt-BR dos números (ponto de milhar, vírgula decimal)
 * com o SÍMBOLO da moeda estrangeira na frente. O usuário é brasileiro: ler
 * "US$ 6,834.56" no meio de uma frase em português confunde mais do que ajuda.
 */
function formatar(valor, moeda) {
  const m = normalizarMoeda(moeda);
  const n = Number(valor) || 0;
  // `casas` só existe nas moedas sem centavos (iene, peso chileno); as
  // outras seguem em 2, que é o padrão de quase todo lugar.
  const casas = MOEDAS[m].casas ?? 2;
  const txt = n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  return `${MOEDAS[m].simbolo} ${txt}`;
}

/**
 * Formatador de dinheiro DO GRUPO, pros textos do WhatsApp (Fase 3 do plano da
 * moeda base): `const fmt = await formatadorDoGrupo(grupoId)` e depois `fmt(v)`.
 *
 * ⚠️ NUNCA escrever `R$ ${v.toFixed(2)}` num texto novo: num grupo em dólar
 * isso mostra dólar com cara de real. E a grafia segue o IDIOMA (pt-BR), não a
 * moeda — decisão do dono: "US$ 1.234,56", não "US$ 1,234.56".
 *
 * A base é cacheada por 10 min (moedaBaseDoGrupo), então chamar uma vez por
 * mensagem não custa ida de rede.
 */
async function formatadorDoGrupo(grupoId) {
  const base = await moedaBaseDoGrupo(grupoId);
  return (v) => formatar(v, base);
}

/**
 * Soma o saldo de uma lista de carteiras NA MOEDA BASE, buscando câmbio só se
 * houver carteira fora da base (migration 168).
 *
 * ⚠️ Existe pra foto do patrimônio, que somava `wallets.saldo` CRU: a conta do
 * banco (em real) num grupo em dólar entrava como dólar, e a coroa num grupo em
 * real entrava como real. Sem nenhuma carteira fora da base é a soma de sempre,
 * sem ida de rede. Carteira sem câmbio fica fora (nunca entra crua).
 * Quem busca as carteiras TEM de pedir `moeda` no select.
 */
async function totalDeSaldosNaBase(wallets, base) {
  const ws = wallets || [];
  const b = normalizarMoeda(base);
  if (!ws.some((w) => normalizarMoeda(w.moeda) !== b)) {
    return ws.reduce((s, w) => s + (Number(w.saldo) || 0), 0);
  }
  return somarSaldos(ws, await taxasParaBase(ws.map((w) => w.moeda), b), b).total;
}

/** Valor nativo de uma transação (pra tela da conta em moeda estrangeira). */
function valorNativo(tx) {
  if (tx?.valor_moeda !== null && tx?.valor_moeda !== undefined) return Number(tx.valor_moeda);
  return Number(tx?.valor) || 0;
}

/**
 * O `valor_moeda` que acompanha um `valor` (na base) EDITADO numa linha já
 * convertida (migration 168).
 *
 * ⚠️ Sem isto, editar só o `valor` deixava o original parado — e é pelo
 * original que a fatura do cartão e o saldo da conta andam. A edição sumia da
 * fatura e aparecia no dashboard: dois números pro mesmo lançamento.
 *
 * Usa a taxa CONGELADA da linha (`taxa_brl` = taxa pra base, nome histórico):
 * quem corrige US$ 100 → US$ 110 numa compra em real ajusta a mesma compra,
 * não a reconverte pelo câmbio de hoje. Linha gravada sem câmbio (onde
 * `valor` = `valor_moeda`): o próprio valor. `undefined` quando a linha não é
 * convertida — não há original pra acompanhar e o patch fica como antes.
 */
function originalDoValorNaBase(valorBase, linha) {
  if (!linha || !linha.moeda) return undefined;
  const v = Number(valorBase) || 0;
  const t = Number(linha.taxa_brl);
  if (!Number.isFinite(t) || t <= 0) return v;
  const escala = 10 ** (MOEDAS[normalizarMoeda(linha.moeda)].casas ?? 2);
  return Math.round((v / t) * escala) / escala;
}

/**
 * Anexa `moeda`, `saldo_brl` e `taxa_brl` numa lista de carteiras.
 *
 * ⚠️ FONTE ÚNICA — vivia dentro de `routes/wallets.js` e por isso só a ABA DE
 * CONTAS convertia. O `/api/dashboard` monta a própria lista de carteiras e
 * devolvia elas CRUAS: o painel de contas mostrava os saldos convertidos e o
 * dashboard, no mesmo minuto, dizia "câmbio indisponível" nas três contas
 * estrangeiras e somava só as em real (R$ 12.202,18 de um total de
 * R$ 15.590,01). Duas telas, dois números, no mesmo dado.
 *
 * ⚠️ `saldo_brl` é null quando o câmbio falhou — NUNCA 0. Quem soma precisa
 * saber a diferença entre "vale zero" e "não sei quanto vale".
 */
async function comSaldoBRL(lista) {
  return comSaldoNaBase(lista, PADRAO);
}

/**
 * Anexa, além de `moeda`/`saldo_brl`/`taxa_brl`, os campos NA BASE do grupo:
 * `moeda_base`, `saldo_base` e `taxa_base` (moeda da conta → base).
 *
 * ⚠️ CAMPOS NOVOS, NÃO RENOMEADOS. `lib/swr-cache.ts` guarda payloads antigos no
 * localStorage; trocar `saldo_brl` por outro nome faria o cache chegar sem
 * nenhum dos dois (armadilha 6 do plano). O painel lê `saldo_base` e só cai no
 * `saldo_brl` quando o payload é antigo — e payload antigo é de grupo em real.
 *
 * ⚠️ `saldo_base` é null quando o câmbio falhou — NUNCA 0, pelo mesmo motivo.
 */
async function comSaldoNaBase(lista, base = PADRAO) {
  const ws = lista || [];
  const b = normalizarMoeda(base);
  if (b === PADRAO && !ws.some((w) => normalizarMoeda(w.moeda) !== PADRAO)) {
    // Caminho de 99% dos grupos: nenhuma conta estrangeira, nenhuma ida de
    // rede. Os campos na base são o espelho do saldo.
    return ws.map((w) => {
      const s = Number(w.saldo) || 0;
      return { ...w, moeda: normalizarMoeda(w.moeda), saldo_brl: s, moeda_base: b, saldo_base: s };
    });
  }
  const tabela = await taxas([...ws.map((w) => w.moeda), b]);
  return ws.map((w) => {
    const m = normalizarMoeda(w.moeda);
    return {
      ...w,
      moeda: m,
      saldo_brl: saldoEmBRL({ saldo: w.saldo, moeda: w.moeda }, tabela),
      taxa_brl: tabela[m] ?? null,
      moeda_base: b,
      saldo_base: saldoNaBase({ saldo: w.saldo, moeda: w.moeda }, b, tabela),
      taxa_base: taxaEntre(m, b, tabela),
    };
  });
}

/**
 * Busca e GRAVA a cotação de todas as moedas suportadas.
 *
 * ⚠️ EXISTE PRA QUE "câmbio indisponível" NUNCA APAREÇA. O fallback do banco
 * só salva quem já tem linha lá, e a linha só nasce na primeira conversão
 * bem-sucedida — ou seja, a PRIMEIRA vez que alguém usa uma moeda nova é
 * justamente a única em que não há rede de segurança. Rodando isto todo dia,
 * toda moeda do catálogo já tem um valor guardado antes de o primeiro
 * usuário precisar dela.
 *
 * ⚠️ IGNORA O CACHE DE MEMÓRIA de propósito (`taxaParaBRLDetalhe` direto): o
 * objetivo aqui é REFRESCAR o que está no banco, e passar por `taxa()`
 * devolveria o valor de uma hora atrás sem gravar nada.
 *
 * Tolerante por moeda: uma fonte fora do ar não impede as outras moedas.
 * Devolve `{ ok, falhas }` pro log do cron dizer o que aconteceu.
 */
async function aquecerCotacoes() {
  const moedas = Object.keys(MOEDAS).filter((m) => m !== PADRAO);
  let ok = 0;
  const falhas = [];
  for (const m of moedas) {
    try {
      const { taxa: t, fonte } = await taxaParaBRLDetalhe(m);
      if (t && Number.isFinite(t) && t > 0) {
        cache.set(m, { taxa: t, em: Date.now() });
        await salvarTaxa(m, t, fonte);
        ok += 1;
      } else falhas.push(m);
    } catch { falhas.push(m); }
  }
  return { ok, falhas };
}

/**
 * Recalcula o `valor` (na base do grupo) das contas fixas em moeda estrangeira.
 *
 * ⚠️ ESTE É O ÚNICO LUGAR QUE ESCREVE ESSE CAMPO por causa de câmbio, e é o
 * que permite os outros 22 consumidores continuarem apenas LENDO `valor` na
 * base. A alternativa — converter na leitura — espalharia cotação por toda a
 * projeção dos Previstos, saldo projetado, agenda, Oráculo e resumo do zap.
 *
 * ⚠️ O NATIVO É A FONTE. Recalcular a partir do `valor` (que já está na base)
 * faria a conta encolher a cada dia, multiplicando a cotação sobre si mesma.
 *
 * ⚠️ A TAXA É PARA A BASE DE CADA GRUPO, não pro real. Cada recorrência pode ser
 * de um grupo com base diferente; `moedaBaseDoGrupo` tem cache, então isto custa
 * uma leitura por grupo, não por recorrência.
 *
 * Sem a migration 160 a coluna não existe: a consulta falha, devolve zero e
 * o cron segue — nada quebra.
 */
async function atualizarRecorrenciasEstrangeiras() {
  let atualizadas = 0;
  let erros = 0;
  try {
    const { data } = await supabase.from('recorrencias')
      .select('id, grupo_id, valor, valor_moeda, moeda').not('moeda', 'is', null);
    for (const r of data || []) {
      const nativo = Number(r.valor_moeda);
      if (!Number.isFinite(nativo) || !r.moeda) continue;
      const base = await moedaBaseDoGrupo(r.grupo_id);
      const t = taxaEntre(r.moeda, base, await taxas([r.moeda, base]));
      // Sem cotação, NÃO mexe: o valor de ontem é melhor que um zero.
      if (t === null) { erros += 1; continue; }
      const escala = 10 ** (MOEDAS[normalizarMoeda(base)].casas ?? 2);
      const naBase = Math.round(nativo * t * escala) / escala;
      if (naBase === Number(r.valor)) continue;   // nada mudou, não escreve
      const { error } = await supabase.from('recorrencias')
        .update({ valor: naBase, taxa_brl: t }).eq('id', r.id);
      if (error) erros += 1; else atualizadas += 1;
    }
  } catch { /* sem a 160 a coluna não existe — segue sem atualizar */ }
  return { atualizadas, erros };
}

module.exports = {
  PADRAO, MOEDAS,
  normalizarMoeda, ehEstrangeira,
  taxa, taxas, paraBRL,
  // Moeda base do grupo (migration 168) — o BRL vira pivô, não significado.
  taxaEntre, paraBase, moedaBaseDoGrupo, esquecerMoedaBase, baseDisponivel, marcarBaseIndisponivel,
  taxasParaBase, saldoNaBase, comSaldoNaBase, fatorCotacaoParaBase, cartaoForaDaBase, motivoCartaoForaDaBase,
  saldoEmBRL, somarSaldos, totalDeSaldosNaBase,
  camposTransacao, valorNativo, originalDoValorNaBase, formatar, formatadorDoGrupo,
  comSaldoBRL, aquecerCotacoes, atualizarRecorrenciasEstrangeiras,
};
