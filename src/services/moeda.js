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
//    Esse número é um FATO e não pode variar com o câmbio. O equivalente em
//    reais é DERIVADO (`saldoEmBRL`) e esse sim muda todo dia — que é o certo.
//
// 2. `transacoes.valor` é SEMPRE BRL, congelado na entrada. É o que mantém
//    dashboard, categorias, relatórios, limites, Wrapped e Oráculo corretos sem
//    nenhuma alteração neles. Converter na hora de exibir faria o "gasto de
//    março" mudar todo dia junto com o dólar.
//
// ⚠️ FALHA DE CÂMBIO NUNCA VIRA ZERO. Se a cotação não vier (Yahoo fora do ar,
// rede caindo), `taxas()` devolve o que tiver em cache e a conversão devolve
// `null` — nunca 0. Somar 0 apagaria o dinheiro do cliente da tela sem avisar,
// que é infinitamente pior do que mostrar "câmbio indisponível".
// =============================================================================
const { taxaParaBRL } = require('./cotacoes');

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

/** A carteira/valor está em moeda estrangeira? */
function ehEstrangeira(moeda) {
  return normalizarMoeda(moeda) !== PADRAO;
}

// ── Cache de câmbio ─────────────────────────────────────────────────────────
// Câmbio não muda de minuto a minuto pro que a Sora faz, e cada leitura é uma
// ida ao Yahoo. TTL de 1h; o valor velho é MANTIDO se a busca falhar.
const TTL_MS = 60 * 60 * 1000;
const cache = new Map();   // moeda → { taxa, em }

async function taxa(moeda) {
  const m = normalizarMoeda(moeda);
  if (m === PADRAO) return 1;

  const hit = cache.get(m);
  if (hit && Date.now() - hit.em < TTL_MS) return hit.taxa;

  try {
    const t = await taxaParaBRL(m);
    if (t && Number.isFinite(t) && t > 0) {
      cache.set(m, { taxa: t, em: Date.now() });
      return t;
    }
  } catch { /* cai no fallback abaixo */ }

  // ⚠️ Cotação falhou. Devolve a ÚLTIMA conhecida, por velha que seja — um
  // número de ontem é muito melhor que sumir com o saldo. Sem cache nenhum,
  // devolve null e quem chama decide (nunca 0).
  return hit ? hit.taxa : null;
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

/**
 * Converte um valor da moeda nativa pra BRL.
 * Devolve `null` quando não há câmbio — NUNCA 0.
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
 * Soma o saldo de várias carteiras EM BRL, avisando o que não deu pra converter.
 *
 * Devolve `{ total, semCambio }`. `semCambio` > 0 significa que o total está
 * INCOMPLETO — a tela precisa dizer isso, não fingir que o número é final.
 */
function somarSaldos(wallets, tabela) {
  let total = 0;
  let semCambio = 0;
  for (const w of wallets || []) {
    const v = saldoEmBRL(w, tabela);
    if (v === null) { semCambio++; continue; }
    total += v;
  }
  return { total, semCambio };
}

/**
 * Monta os campos de moeda de uma transação nova.
 *
 * `valorNativo` vem na moeda da CARTEIRA. Devolve o que gravar:
 *   · `valor`       → SEMPRE BRL (é o que todo o resto do sistema soma)
 *   · `valor_moeda` → o nativo, pra tela da conta mostrar US$
 *   · `taxa_brl`    → congelada agora, pra o histórico não mudar depois
 *
 * ⚠️ Em BRL devolve os três campos NULOS (menos `valor`): a linha fica
 * idêntica ao que já se grava hoje, sem nenhum efeito colateral.
 */
function camposTransacao(valorNativo, moeda, tabela) {
  const m = normalizarMoeda(moeda);
  const v = Number(valorNativo) || 0;
  if (m === PADRAO) return { valor: v, moeda: null, valor_moeda: null, taxa_brl: null };

  const t = tabela ? tabela[m] : null;
  if (!t || !Number.isFinite(t)) {
    // ⚠️ Sem câmbio, grava o nativo em `valor` com taxa 1 e REGISTRA a moeda.
    // Assim o dinheiro não some da conta do usuário; o número fica provisório e
    // a tela mostra a moeda, deixando claro que não é real convertido.
    return { valor: v, moeda: m, valor_moeda: v, taxa_brl: null };
  }
  return {
    valor: v * t,          // BRL congelado
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

/** Valor nativo de uma transação (pra tela da conta em moeda estrangeira). */
function valorNativo(tx) {
  if (tx?.valor_moeda !== null && tx?.valor_moeda !== undefined) return Number(tx.valor_moeda);
  return Number(tx?.valor) || 0;
}

module.exports = {
  PADRAO, MOEDAS,
  normalizarMoeda, ehEstrangeira,
  taxa, taxas, paraBRL,
  saldoEmBRL, somarSaldos,
  camposTransacao, valorNativo, formatar,
};
