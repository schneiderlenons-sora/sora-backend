// =====================================================================
// Sincroniza um CONSENTIMENTO Celcoin (Polp v2) com a Sora.
//
//   conta        → wallets                 (of_conta_id)
//   cartão       → wallets tipo 'Crédito'  (+ limite/fechamento/vencimento/mínimo)
//   transação    → transacoes              (dedup por of_tx_id)
//   empréstimo   → dividas                 (dedup por of_id — migration 100)
//   financiamento→ dividas
//   investimento → investimentos           (dedup por of_id — migration 069)
//
// Doc destilada: docs/CELCOIN-API.md. Convive com o trilho Pluggy
// (services/polpSync.js) — quem decide é of_conexoes.provider.
//
// CUIDADOS QUE ESTE ARQUIVO IMPLEMENTA (cada um é um bug evitado):
//   1. Dinheiro vem como STRING em { amount, currency } → sempre parseFloat.
//   2. `null` é normal (balance/identification/product/limits antes da 1ª sync);
//      distinguimos "não sincronizado" (null) de "zero" (0).
//   3. `limits[]` é ARRAY por linha de crédito → pegar LIMITE_CREDITO_TOTAL.
//   4. Cartão: usar `brazilian_amount` (BRL), não `amount` (moeda original).
//   5. Não importar lançamento futuro: conta usa
//      completed_authorised_payment_type=LANCAMENTO_FUTURO; cartão usa data > hoje
//      (parcela a vencer viraria "gasto em 2027").
//   6. `transaction_type=PAGAMENTO_FATURA` é transferência, não gasto.
//   7. Percentual/taxa vêm em DOIS formatos na doc (1.0 e 100 pra "100% do CDI")
//      → normalizamos em pct().
//   8. `dividas.taxa_juros` é % ao MÊS e o CET da Celcoin é ANUAL → convertemos.
// =====================================================================
const supabase = require('../db/supabase');
const celcoin  = require('./polpCelcoin');
const { categorizarDescricao, mapearCategoriaPluggy, CATEGORIA_FATURA } = require('./categorizar');
const { cicloPorCompetencia, competenciaAtual, hojeSP } = require('./cicloFatura');

const PROVIDER = 'polp-celcoin';
const idCurto = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// ── Helpers de valor ────────────────────────────────────────────────────────

/**
 * Valor monetário da Celcoin → number. Aceita { amount, currency }, string ou
 * número. Devolve `null` quando não há dado (≠ 0), pra não gravar "saldo zero"
 * quando o recurso simplesmente ainda não sincronizou.
 */
function money(v) {
  if (v == null) return null;
  const bruto = typeof v === 'object' ? v.amount : v;
  if (bruto == null || bruto === '') return null;
  const n = parseFloat(String(bruto).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const money0 = (v) => money(v) ?? 0;
const moeda  = (v) => (v && typeof v === 'object' && v.currency) || 'BRL';
const cent   = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Percentual/taxa da Celcoin → % (base 100).
 * A doc é AMBÍGUA: descreve `post_fixed_indexer_percentage` como
 * "1.000000 = 100% do CDI" mas a tabela de exemplos usa "100 para 100% do CDI";
 * idem `pre_fixed_rate` ("0.150000 = 15%" vs "16.76" pra 16,76%).
 * Regra: valor ≤ 2 é fração (×100); acima disso já está em %.
 */
function pct(v) {
  const n = money(v);
  if (n == null) return null;
  const abs = Math.abs(n);
  if (abs === 0) return 0;
  return abs <= 2 ? cent(n * 100) : cent(n);
}

/** CET anual (0.29 = 29% a.a.) → taxa mensal equivalente em % (juros compostos). */
function cetParaMensal(cet) {
  const anual = money(cet);
  if (anual == null || anual <= 0) return null;
  // Mesma ambiguidade do pct(): 0.29 = 29% a.a.; 29 já é 29%.
  const frac = Math.abs(anual) <= 2 ? Math.abs(anual) : Math.abs(anual) / 100;
  const mensal = (Math.pow(1 + frac, 1 / 12) - 1) * 100;
  return Number.isFinite(mensal) ? Math.round(mensal * 10000) / 10000 : null;
}

const ymd = (d) => (d ? String(d).slice(0, 10) : null);

/** Dia do mês 1..31 de uma data ISO (migration 068 libera até 31). */
function diaDoMes(iso) {
  const s = ymd(iso);
  if (!s) return null;
  const d = Number(s.slice(8, 10));
  return d >= 1 && d <= 31 ? d : null;
}

// ── Categoria: taxonomia Celcoin → categorias da Sora (v3) ──────────────────
// A descrição da transação decide primeiro (pega marca BR: iFood, Netflix…);
// este mapa entra como 2ª opção, e é bem mais preciso que adivinhar.
const MAPA_CATEGORIA_CELCOIN = {
  // Receitas
  INCOME_SALARY: 'Salário', INCOME_RETIREMENT_PENSION: 'Salário',
  INCOME_CONTRACTOR: 'Freelance', INCOME_GIG_ECONOMY: 'Freelance',
  INCOME_DIVIDENDS: 'Rendimentos', INCOME_INTEREST_EARNED: 'Rendimentos',
  INCOME_RENTAL: 'Aluguéis', INCOME_TAX_REFUND: 'Restituição de IR',
  // Transferências / investimento
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'Investimentos',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'Investimentos',
  TRANSFER_OUT_SAVINGS: 'Investimentos', TRANSFER_IN_SAVINGS: 'Investimentos',
  TRANSFER_OUT_WITHDRAWAL: 'Transferências',
  // Cartão / empréstimo
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: CATEGORIA_FATURA,
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: 'Empréstimos',
  LOAN_PAYMENTS_CAR_PAYMENT: 'Financiamento',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Financiamento',
  // Tarifas
  BANK_FEES_ATM_FEES: 'Tarifas bancárias', BANK_FEES_OTHER_BANK_FEES: 'Tarifas bancárias',
  BANK_FEES_OVERDRAFT_FEES: 'Tarifas bancárias', BANK_FEES_INSUFFICIENT_FUNDS: 'Tarifas bancárias',
  BANK_FEES_INTEREST_CHARGE: 'Juros', BANK_FEES_LATE_FEES: 'Juros',
  BANK_FEES_FOREIGN_TRANSACTION_FEES: 'IOF',
  // Alimentação
  FOOD_AND_DRINK_GROCERIES: 'Supermercado', FOOD_AND_DRINK_RESTAURANT: 'Restaurante',
  FOOD_AND_DRINK_FAST_FOOD: 'Lanches', FOOD_AND_DRINK_COFFEE: 'Café',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'Bares', FOOD_AND_DRINK: 'Alimentação',
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK: 'Alimentação',
  // Transporte
  TRANSPORTATION_GAS: 'Combustível', TRANSPORTATION_PARKING: 'Estacionamento',
  TRANSPORTATION_TOLLS: 'Pedágio', TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'Uber',
  TRANSPORTATION_PUBLIC_TRANSIT: 'Ônibus', TRANSPORTATION: 'Transporte',
  // Saúde
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'Farmácia', MEDICAL_PRIMARY_CARE: 'Consultas',
  MEDICAL_DENTAL_CARE: 'Dentista', MEDICAL_VETERINARY_SERVICES: 'Pets',
  MEDICAL_EYE_CARE: 'Saúde', MEDICAL: 'Saúde',
  // Casa / contas
  RENT_AND_UTILITIES_RENT: 'Aluguel', RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'Conta de Luz',
  RENT_AND_UTILITIES_WATER: 'Água', RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'Internet',
  RENT_AND_UTILITIES_TELEPHONE: 'Celular', HOME_IMPROVEMENT_FURNITURE: 'Móveis',
  HOME_IMPROVEMENT: 'Manutenção',
  // Entretenimento / assinatura
  ENTERTAINMENT_TV_AND_MOVIES: 'Streaming', ENTERTAINMENT_MUSIC_AND_AUDIO: 'Streaming',
  ENTERTAINMENT_VIDEO_GAMES: 'Jogos', ENTERTAINMENT: 'Lazer',
  // Compras
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: 'Encomendas',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'Roupas',
  GENERAL_MERCHANDISE_ELECTRONICS: 'Eletrônicos',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'Pets',
  GENERAL_MERCHANDISE_SUPERSTORES: 'Supermercado',
  GENERAL_MERCHANDISE: 'Compras',
  // Pessoal / serviços
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Academia',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'Salão de beleza',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: 'Lavanderia',
  GENERAL_SERVICES_EDUCATION: 'Educação', GENERAL_SERVICES_INSURANCE: 'Seguros',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'Fretes',
  // Viagem / governo
  TRAVEL_FLIGHTS: 'Viagem', TRAVEL_LODGING: 'Hospedagem', TRAVEL: 'Viagem',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'Impostos',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Doações',
};

function categoriaDe(descricao, categoryRef) {
  // 1) descrição (motor local — reconhece marca brasileira)
  const porDesc = categorizarDescricao(descricao);
  if (porDesc) return porDesc;
  // 2) taxonomia da Celcoin (exata, depois o pai)
  if (categoryRef) {
    if (MAPA_CATEGORIA_CELCOIN[categoryRef]) return MAPA_CATEGORIA_CELCOIN[categoryRef];
    const raiz = String(categoryRef).split('_')[0];
    if (MAPA_CATEGORIA_CELCOIN[raiz]) return MAPA_CATEGORIA_CELCOIN[raiz];
    // 3) último recurso: o mapa de keywords já existente (casa em inglês)
    const porKw = mapearCategoriaPluggy(String(categoryRef).replace(/_/g, ' '));
    if (porKw) return porKw;
  }
  return 'Outros';
}

// ── Normalização: CONTA ─────────────────────────────────────────────────────
const TIPO_CONTA = {
  CONTA_DEPOSITO_A_VISTA: 'Corrente',
  CONTA_POUPANCA: 'Poupança',
  CONTA_PAGAMENTO_PRE_PAGA: 'Corrente',
};

function normalizeConta(acc) {
  const ident = acc.identification || {};
  const bal   = acc.balance || null;
  const over  = acc.overdraft_limit || null;
  const tipo  = TIPO_CONTA[ident.type || acc.type] || 'Corrente';

  // Nome: a conta não tem "nome" no Open Finance — montamos com o banco + tipo.
  const banco = (acc.brand_name || 'Banco').toString().trim();
  const sufixo = tipo === 'Poupança' ? ' Poupança' : '';
  const nome = `${banco}${sufixo}`.slice(0, 60);

  // Saldo = disponível. `blocked` e `automatically_invested` NÃO entram: o
  // primeiro não é gastável e o segundo é investimento (entra na aba própria).
  const disponivel = bal ? money(bal.available_amount) : null;

  return {
    externalId: String(acc.id),
    nome,
    tipo,
    saldo: disponivel,                     // null = ainda não sincronizado
    moeda: ident.currency || moeda(bal && bal.available_amount),
    extras: {
      // Cheque especial contratado (a Sora já tem esse conceito — migration 094).
      cheque_especial: over ? money(over.overdraft_contracted_limit) : null,
    },
    sincronizado: !!bal,
  };
}

// ── Normalização: CARTÃO ────────────────────────────────────────────────────
const BANDEIRA = {
  VISA: 'Visa', MASTERCARD: 'Mastercard', ELO: 'Elo', HIPERCARD: 'Hipercard',
  AMERICAN_EXPRESS: 'Amex', DINERS_CLUB: 'Diners',
};

/**
 * Limite TOTAL do cartão. `limits[]` traz uma linha por modalidade
 * (CREDITO_A_VISTA, CREDITO_PARCELADO, SAQUE_*) e por consolidação
 * (CONSOLIDADO/INDIVIDUAL). O limite do cartão é o LIMITE_CREDITO_TOTAL;
 * preferimos CONSOLIDADO quando existe (é o teto do cartão inteiro).
 */
function limiteTotalDoCartao(limits) {
  const arr = Array.isArray(limits) ? limits : [];
  const totais = arr.filter((l) => l && l.credit_line_limit_type === 'LIMITE_CREDITO_TOTAL');
  const escolhido =
    totais.find((l) => l.consolidation_type === 'CONSOLIDADO') ||
    totais[0] ||
    // Sem LIMITE_CREDITO_TOTAL: pega o maior limite informado (melhor que nada).
    arr.slice().sort((a, b) => (money0(b && b.limit_amount) - money0(a && a.limit_amount)))[0];
  if (!escolhido) return { limite: null, usado: null, disponivel: null };
  return {
    limite: money(escolhido.limit_amount),
    usado: money(escolhido.used_amount),
    disponivel: money(escolhido.available_amount),
  };
}

/** Total já pago numa fatura (soma de payments[]). */
function pagoDaFatura(bill) {
  return cent((bill && Array.isArray(bill.payments) ? bill.payments : [])
    .reduce((s, p) => s + money0(p && p.amount !== undefined ? p.amount : p), 0));
}

/**
 * Fatura em ABERTO = a de vencimento mais próximo que ainda NÃO passou.
 *
 * ⚠️ NÃO tem fallback pra "a mais recente". Isso era um bug caro: o `List Bills`
 * do emissor só publica a fatura DEPOIS que ela fecha (bug conhecido da Polp —
 * ver CLAUDE.md), então no meio do ciclo a lista termina na fatura PASSADA.
 * Com fallback, essa fatura já vencida virava `of_bill_atual`, e a tela somava
 * as compras dela + as compras do ciclo novo como se fossem uma fatura só.
 * Medido numa conta real: R$ 3.143,75 (fatura de julho, já paga) + R$ 1.870,24
 * (ciclo de agosto) = R$ 5.013,99 exibidos onde o banco mostrava R$ 3.423,57.
 *
 * Sem fatura publicada, o certo é devolver `null` e deixar o valor vir do
 * LIMITE USADO (regra de ouro) — não fingir que uma fatura fechada é a atual.
 */
function escolherFaturaAberta(bills, hoje) {
  const arr = (Array.isArray(bills) ? bills : []).filter((b) => b && b.due_date);
  if (!arr.length) return null;
  const ordenadas = arr.slice().sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  return ordenadas.find((b) => ymd(b.due_date) >= hoje) || null;
}

/** Fatura mais recente publicada — serve pras DATAS (dia de fechamento e de
 *  vencimento mudam pouco), nunca pro VALOR da fatura atual. */
function ultimaFaturaPublicada(bills) {
  const arr = (Array.isArray(bills) ? bills : []).filter((b) => b && b.due_date);
  if (!arr.length) return null;
  return arr.slice().sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))).pop();
}

/**
 * REGRA DE OURO da fatura de cartão (CLAUDE.md):
 *
 *     fatura = limite usado − parcelas a vencer
 *
 * O limite usado é o único número que o emissor mantém correto ANTES de a
 * fatura fechar. Ele inclui as parcelas futuras (que ocupam limite mas não estão
 * nesta fatura), então elas são descontadas — medidas nas transações com data no
 * FUTURO que a API manda, nunca projetadas (projetar já deu 6.379 onde o real
 * era 2.504).
 *
 * Somar as transações importadas NÃO resolve: as parcelas que compõem a fatura
 * aberta só chegam quando ela é publicada. Por isso a soma sai sempre a MENOS.
 */
function faturaPorLimite(usado, futuras) {
  if (usado == null) return null;
  return Math.max(0, cent(usado - (futuras || 0)));
}

/**
 * Fatura em aberto somada pelas TRANSAÇÕES — usada quando o banco ainda não
 * publicou o `bill_total_amount`, que é o normal ENQUANTO O CICLO NÃO FECHA
 * (o Mercado Pago manda 0/null o ciclo inteiro; era isso que deixava "R$ 0,00"
 * no painel com 26 compras já importadas).
 *
 * Preferimos o `bill_id`: a Celcoin marca em cada transação a fatura a que ela
 * pertence, então é o agrupamento EXATO do emissor — sem aritmética nossa.
 * Sem ele, cai no CICLO REAL de fechamento, a mesma conta do resto da Sora.
 *
 * Soma só GASTOS, igual ao painel e ao modal do cartão — assim o valor do card,
 * da lista por categoria e do WhatsApp é o MESMO número. Estorno/cashback não
 * abatem aqui (viram transferência); quando o ciclo fecha, o `bill_total_amount`
 * oficial do banco assume e corrige. `null` = não há como agrupar.
 */
function faturaPorTransacoes(normalizadas, crus, n, hoje) {
  const pares = [];
  normalizadas.forEach((norm, i) => { if (norm) pares.push({ norm, cru: crus[i] || {} }); });

  // 1. Exato: agrupamento do próprio emissor.
  const billId = n.faturaAberta && n.faturaAberta.billId;
  if (billId && pares.some((p) => String(p.cru.bill_id || '') === billId)) {
    n.fonteFatura = 'bill_id';
    return cent(pares
      .filter((p) => String(p.cru.bill_id || '') === billId && p.norm.ehGasto)
      .reduce((s, p) => s + p.norm.valor, 0));
  }
  n.fonteFatura = 'ciclo';

  // 2. Ciclo real de fechamento (precisa da data de fechamento do banco).
  const cartao = { dia_fechamento: n.extras.dia_fechamento, dia_vencimento: n.extras.dia_vencimento };
  if (!cartao.dia_fechamento) return null;
  const ciclo = cicloPorCompetencia(cartao, competenciaAtual(cartao, hoje));
  n.cicloLabel = ciclo.label;
  return cent(pares
    .filter((p) => p.norm.ehGasto && ymd(p.norm.data) >= ciclo.ini && ymd(p.norm.data) < ciclo.fimExcl)
    .reduce((s, p) => s + p.norm.valor, 0));
}

// ── Parcelamentos: detecção de duplicata + parcelas a vencer ────────────────
//
// CONTEXTO (suporte da Polp, ago/2026): o Open Finance NÃO tem identificador
// único da compra parcelada, então a Polp agrupa as parcelas por heurística
// (descrição + valor + data + nº de parcelas). No Nubank, parcelas da MESMA
// compra chegam com datas diferentes → a mesma compra virava DOIS
// parcelamentos. Eles aplicaram uma correção que resolve ~90% dos casos.
//
// Esta função existe pra MEDIR se a correção chegou, em vez de conferir JSON
// a olho: ela reagrupa por conta própria e diz quantas duplicatas sobraram.

/** Campos do parcelamento, tolerante a camelCase (doc) e snake_case. */
function normalizeParcelamento(p) {
  const g = (...ks) => { for (const k of ks) if (p && p[k] != null) return p[k]; return null; };
  const total = Number(g('totalInstallments', 'total_installments')) || 0;
  const achadas = Number(g('paidInstallments', 'paid_installments')) || 0;
  const ocorrencias = g('occurrences') || [];
  const nOcor = Array.isArray(ocorrencias) ? ocorrencias.length : 0;
  return {
    descricao: String(g('description') || '').trim(),
    valorParcela: Math.abs(money0(g('amount'))),
    totalParcelas: total,
    // ⚠️ NÃO é "pagas" — é quantas parcelas a Polp ENCONTROU (len(occurrences)).
    parcelasEncontradas: achadas || nOcor,
    ocorrencias: nOcor,
  };
}

/**
 * Assinatura da COMPRA (não da linha). Tira o marcador de parcela da descrição
 * ("HOTEIS.COM 12/12" → "HOTEIS.COM"), que é justamente o que faz duas linhas
 * da mesma compra parecerem compras diferentes.
 */
function assinaturaCompra(it) {
  const desc = it.descricao
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')         // tira acento
    .toUpperCase()
    .replace(/\b\d{1,2}\s*\/\s*\d{1,2}\b/g, '')          // marcador "3/12"
    .replace(/\s+/g, ' ')
    .trim();
  return `${desc}|${it.valorParcela.toFixed(2)}|${it.totalParcelas}`;
}

/**
 * Analisa a lista de parcelamentos de um cartão.
 *
 * Devolve as DUAS leituras de "parcelas a vencer" porque elas divergem e só a
 * comparação com o app do banco decide qual vale:
 *   · `todas_restantes` = (total − encontradas) × valor — tudo que falta;
 *   · `fora_da_aberta`  = (total − encontradas − 1) × valor — desconta a
 *      parcela que já está caindo na fatura em aberto.
 *
 * Cada uma é calculada com a lista CRUA e com a DEDUPLICADA (mantendo, em cada
 * grupo, a linha com mais parcelas encontradas — a mais completa). Se a
 * correção da Polp chegou, `duplicatas` é 0 e as duas colunas se igualam.
 */
function analisarParcelamentos(lista) {
  const itens = (Array.isArray(lista) ? lista : []).map(normalizeParcelamento)
    .filter((it) => it.totalParcelas > 0 && it.valorParcela > 0);

  const grupos = new Map();
  for (const it of itens) {
    const k = assinaturaCompra(it);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(it);
  }

  const duplicados = [];
  const deduplicado = [];
  for (const [chave, g] of grupos) {
    // Mais parcelas encontradas = leitura mais completa daquela compra.
    const melhor = g.slice().sort((a, b) => b.parcelasEncontradas - a.parcelasEncontradas)[0];
    deduplicado.push(melhor);
    if (g.length > 1) {
      duplicados.push({
        chave,
        linhas: g.length,
        descricoes: g.map((x) => x.descricao),
        parcelas_encontradas: g.map((x) => x.parcelasEncontradas),
        valor_parcela: melhor.valorParcela,
        total_parcelas: melhor.totalParcelas,
      });
    }
  }

  const somar = (arr, descontarAberta) => cent(arr.reduce((s, it) => {
    const restantes = Math.max(0, it.totalParcelas - it.parcelasEncontradas - (descontarAberta ? 1 : 0));
    return s + restantes * it.valorParcela;
  }, 0));

  return {
    parcelamentos: itens.length,
    compras_distintas: grupos.size,
    duplicatas: duplicados.length,          // 0 = correção da Polp chegou
    detalhe_duplicatas: duplicados,
    // Uma linha por compra. Serve pra CONFERIR a plausibilidade do agrupamento:
    // se todas as compras aparecem com exatamente 1 parcela restante, é sinal de
    // que `paidInstallments` está contando a parcela da fatura em aberto — e aí
    // "parcelas a vencer" não pode ser lido como (total − encontradas).
    detalhe: deduplicado.map((it) => ({
      descricao: it.descricao,
      valor_parcela: it.valorParcela,
      total: it.totalParcelas,
      encontradas: it.parcelasEncontradas,
      restantes: Math.max(0, it.totalParcelas - it.parcelasEncontradas),
    })),
    futuras: {
      cru:         { todas_restantes: somar(itens, false),       fora_da_aberta: somar(itens, true) },
      deduplicado: { todas_restantes: somar(deduplicado, false), fora_da_aberta: somar(deduplicado, true) },
    },
  };
}

function normalizeCartao(card, bills, hoje) {
  const ident = card.identification || {};
  const nome = (ident.name || card.name || card.brand_name || 'Cartão').toString().trim().slice(0, 60);
  const { limite, usado, disponivel } = limiteTotalDoCartao(card.limits);
  const aberta = escolherFaturaAberta(bills, hoje);
  // As DATAS podem vir da última fatura publicada mesmo quando ela já fechou —
  // dia de fechamento e de vencimento não mudam de um mês pro outro. O VALOR,
  // não: esse só sai de uma fatura de fato aberta.
  const paraDatas = aberta || ultimaFaturaPublicada(bills);

  // Últimos 4 dígitos: pega o 1º método de pagamento (titular).
  const pm = Array.isArray(ident.payment_methods) ? ident.payment_methods[0] : null;
  const ultimos4 = pm && pm.identification_number
    ? String(pm.identification_number).replace(/\D/g, '').slice(-4) || null
    : null;

  // A FATURA vem do banco: total − o que já foi pago nela.
  const totalFatura = aberta ? money(aberta.bill_total_amount) : null;
  const faturaRestante = totalFatura == null ? null : Math.max(0, cent(totalFatura - pagoDaFatura(aberta)));

  return {
    externalId: String(card.id),
    nome,
    tipo: 'Crédito',
    // Convenção da Sora pro cartão: saldo negativo = fatura a pagar.
    // (O painel lê `Math.max(-saldo, 0)` como fatura do cartão OF.)
    saldoFatura: faturaRestante == null ? null : -faturaRestante,
    // Limite USADO informado pelo emissor — é a base da regra de ouro e o único
    // número correto enquanto a fatura não fecha. Guardado pra tela poder usar.
    limiteUsado: usado,
    limiteDisponivel: disponivel,
    extras: {
      limite,
      // ⭐ A Celcoin ENTREGA as datas — a Pluggy mandava balanceCloseDate null e
      // nos obrigava a pedir o fechamento na mão. Vêm da última fatura conhecida
      // (o dia de fechamento não muda de mês pra mês); zerar isso quando a
      // fatura aberta ainda não foi publicada quebraria o ciclo da tela inteira.
      dia_fechamento: paraDatas ? diaDoMes(paraDatas.bill_closing_date) : null,
      dia_vencimento: paraDatas ? diaDoMes(paraDatas.due_date) : null,
      bandeira: BANDEIRA[(card.credit_card_network || ident.credit_card_network || '').toString().toUpperCase()] || null,
      ultimos4,
      pagamento_minimo: aberta ? money(aberta.bill_minimum_amount) : null,
      // Qual fatura está em aberto (migration 101). Só quando ela EXISTE de
      // verdade: apontar pra uma fatura fechada fazia a tela somar as compras
      // dela junto com as do ciclo novo (R$ 5.013,99 no lugar de R$ 3.423,57).
      of_bill_atual: aberta ? String(aberta.id) : null,
      of_limite_usado: usado,
    },
    faturaAberta: aberta
      ? {
          billId: String(aberta.id),
          total: totalFatura,
          pago: pagoDaFatura(aberta),
          restante: faturaRestante,
          fechamento: ymd(aberta.bill_closing_date),
          vencimento: ymd(aberta.due_date),
          parcelada: !!aberta.is_instalment,
        }
      : null,
  };
}

// ── Normalização: TRANSAÇÕES ────────────────────────────────────────────────

/**
 * Lançamentos que ainda NÃO são movimentação de verdade:
 *   LANCAMENTO_FUTURO     → agendado, não aconteceu (viraria despesa no futuro);
 *   TRANSACAO_PROCESSANDO → autorizada, ainda não efetivada. É a pré-autorização
 *     do maquininha/gateway: o emissor manda ela E depois a captura, com IDs
 *     diferentes e centavos diferentes (caso real: "PayU *ADI" R$139,99 e
 *     "PayU *ADIDAS" R$140,00 no mesmo segundo) — importar as duas inflava a
 *     fatura. Não se perde nada: quando efetiva, entra no sync seguinte.
 */
const NAO_EFETIVADA = new Set(['LANCAMENTO_FUTURO', 'TRANSACAO_PROCESSANDO']);
const efetivada = (tx) => !NAO_EFETIVADA.has(String(tx && tx.completed_authorised_payment_type || ''));

/** Transação de CONTA. Devolve `null` quando não deve ser importada. */
function normalizeTxConta(tx) {
  if (!efetivada(tx)) return null;

  const valor = money(tx.transaction_amount);
  if (valor == null) return null;
  const ehGasto = (tx.credit_debit_type || '').toString().toUpperCase() === 'DEBITO';
  const cp = tx.counterparty || {};
  const descricao = (tx.transaction_name || cp.alias || cp.name || '').toString();

  // Transferência entre contas próprias / aporte não é consumo.
  const ref = tx.category_ref || '';
  const ehTransferencia =
    ref === 'TRANSFER_OUT_ACCOUNT_TRANSFER' || ref === 'TRANSFER_IN_ACCOUNT_TRANSFER' ||
    ref === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';

  return {
    externalId: String(tx.id),
    ehGasto,
    valor: Math.abs(valor),
    descricao,
    categoria: ehTransferencia
      ? (ref === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ? CATEGORIA_FATURA : 'Transferências')
      : categoriaDe(descricao, ref),
    data: tx.transaction_date_time || tx.created_at,
    transferencia: ehTransferencia,
    card: null,
  };
}

/** Transação de CARTÃO. Devolve `null` quando não deve ser importada. */
function normalizeTxCartao(tx, hoje) {
  // Pré-autorização/agendamento não entra na fatura (ver NAO_EFETIVADA).
  if (!efetivada(tx)) return null;

  // Parcela a vencer chega com data no futuro — não é gasto de hoje.
  const data = tx.transaction_date_time || tx.bill_post_date;
  if (ymd(data) && ymd(data) > hoje) return null;

  // ⚠️ brazilian_amount (BRL). `amount` é a moeda ORIGINAL (compra internacional).
  const valor = money(tx.brazilian_amount) ?? money(tx.amount);
  if (valor == null) return null;

  const tipoTx = (tx.transaction_type || '').toString().toUpperCase();
  const ehCredito = (tx.credit_debit_type || '').toString().toUpperCase() === 'CREDITO';
  const cp = tx.counterparty || {};
  const descricao = (tx.transaction_name || cp.alias || cp.name || '').toString();

  // Pagamento da fatura, estorno e cashback entram como transferência (não
  // consomem orçamento; a compra original já contou).
  const ehTransferencia = tipoTx === 'PAGAMENTO_FATURA' || tipoTx === 'ESTORNO' || tipoTx === 'CASHBACK' || ehCredito;

  return {
    externalId: String(tx.id),
    ehGasto: !ehCredito,
    valor: Math.abs(valor),
    descricao,
    categoria: ehTransferencia ? CATEGORIA_FATURA : categoriaDe(descricao, tx.category_ref),
    data,
    transferencia: ehTransferencia,
    // Cartão virtual/adicional (a Sora já mostra isso em of_card).
    card: tx.identification_number ? String(tx.identification_number).slice(-4) : null,
    // Fatura a que o EMISSOR vinculou esta linha (migration 101). É o único
    // dado confiável pra parcela: a Celcoin manda as N parcelas com a data da
    // COMPRA, então agrupar por data joga todas na mesma fatura.
    billId: tx.bill_id ? String(tx.bill_id) : null,
  };
}

// ── Normalização: EMPRÉSTIMO / FINANCIAMENTO → dividas ──────────────────────
const TIPO_DIVIDA_SUB = {
  CREDITO_PESSOAL_COM_CONSIGNACAO: 'consignado',
  CHEQUE_ESPECIAL: 'cheque_especial',
  CONTA_GARANTIDA: 'cheque_especial',
  FINANCIAMENTO_HABITACIONAL_SFH: 'financiamento',
  FINANCIAMENTO_HABITACIONAL_EXCETO_SFH: 'financiamento',
  AQUISICAO_BENS_VEICULOS_AUTOMOTORES: 'financiamento',
};
const INDEXADOR_DIVIDA = {
  PRE_FIXADO: 'pre', CDI: 'cdi', SELIC: 'selic', IPCA: 'ipca', IGPM: 'ipca',
};

/**
 * `kind` = 'emprestimo' | 'financiamento'.
 * Devolve `null` se não houver valor contratado (a tabela exige valor_total > 0).
 */
function normalizeDivida(item, kind) {
  const c   = item.contract || {};
  const sch = item.scheduled_instalments || {};
  const pay = item.payments || {};

  const valorTotal = money(c.contract_amount);
  if (!valorTotal || valorTotal <= 0) return null;   // CHECK valor_total > 0

  const tipo = TIPO_DIVIDA_SUB[item.product_sub_type] || (kind === 'financiamento' ? 'financiamento' : 'emprestimo');
  const titulo = (c.product_name || item.product_sub_type || (kind === 'financiamento' ? 'Financiamento' : 'Empréstimo'))
    .toString().replace(/_/g, ' ').slice(0, 120);

  const totalParcelas = Number(sch.total_number_of_instalments) || null;
  const pagas = Number(sch.paid_instalments ?? pay.paid_instalments) || 0;
  const vencidas = Number(sch.past_due_instalments) || 0;

  const status = c.settlement_date ? 'quitada' : vencidas > 0 ? 'em_atraso' : 'ativa';

  // Saldo devedor REAL do banco (antes calculávamos restantes × parcela).
  const saldoDevedor = money(pay.contract_outstanding_balance);
  const taxaIndexador = Array.isArray(c.interest_rates) && c.interest_rates[0]
    ? c.interest_rates[0].referential_rate_indexer_sub_type || c.interest_rates[0].referential_rate_indexer_type
    : null;

  const obs = [
    saldoDevedor != null ? `Saldo devedor: R$ ${saldoDevedor.toFixed(2)}` : null,
    c.cet ? `CET ${(pct(c.cet) ?? 0).toFixed(2)}% a.a.` : null,
    c.amortization_scheduled ? `Amortização ${c.amortization_scheduled}` : null,
    vencidas > 0 ? `${vencidas} parcela(s) em atraso` : null,
    c.contract_number ? `Contrato ${c.contract_number}` : null,
    'Importado do Open Finance',
  ].filter(Boolean).join(' · ').slice(0, 500);

  return {
    externalId: String(item.id),
    titulo,
    credor: (item.brand_name || '').toString().slice(0, 120) || null,
    tipo,
    valor_total: cent(valorTotal),
    valor_parcela: money(c.next_instalment_amount),
    parcelas_total: totalParcelas,
    parcelas_pagas: totalParcelas ? Math.min(pagas, totalParcelas) : pagas,
    // A Sora guarda % ao MÊS; a Celcoin dá CET anual.
    taxa_juros: cetParaMensal(c.cet),
    indexador: INDEXADOR_DIVIDA[(taxaIndexador || '').toString().toUpperCase()] || null,
    dia_vencimento: diaDoMes(c.first_instalment_due_date) || diaDoMes(c.due_date),
    data_inicio: ymd(c.contract_date),
    data_quitacao: ymd(c.settlement_date),
    status,
    observacao: obs,
  };
}

// ── Normalização: INVESTIMENTO → investimentos ──────────────────────────────
// `tipo` tem que ser um dos que a aba de Investimentos conhece (cor + emoji):
// Ações · FIIs · ETFs · Cripto · Tesouro Direto · CDB · Previdência · Reserva ·
// Imóveis · Negócio · Caixa · Renda Fixa · Fundos  (os 2 últimos entram junto
// com este trilho — ver CORES_TIPO no InvestimentosClient).
function tipoInvestimento(inv) {
  const fam = inv.__familia;
  if (fam === 'treasure_title') return 'Tesouro Direto';
  if (fam === 'bank_fixed_income') return 'CDB';        // CDB/RDB/LCI/LCA
  if (fam === 'credit_fixed_income') return 'Renda Fixa'; // Debêntures/CRI/CRA
  if (fam === 'fund') return 'Fundos';
  if (fam === 'variable_income') {
    const t = (inv.product && inv.product.ticker) || '';
    return /11$/.test(String(t)) ? 'FIIs' : 'Ações';    // FII normalmente termina em 11
  }
  return 'Renda Fixa';
}

function normalizeInvestimento(inv) {
  const p = inv.product || {};
  const b = inv.balance || {};
  const rem = p.remuneration || {};
  const fam = inv.__familia;

  // Posição: net_amount é o líquido (o que o usuário resgataria). Renda variável
  // só tem gross_amount.
  const atual = money(b.net_amount) ?? money(b.gross_amount);
  const quantidade = money(b.quantity) ?? money(b.quota_quantity);
  const precoUnit = money(b.updated_unit_price) ?? money(b.quota_gross_price_value) ?? money(b.closing_price);
  const precoCompra = money(b.purchase_unit_price);

  // Aportado: quantidade × preço de compra quando o banco informa; senão fica
  // igual ao atual (rentabilidade 0 é melhor que rentabilidade inventada).
  const aportado = precoCompra != null && quantidade != null
    ? cent(precoCompra * quantidade)
    : (atual ?? null);

  const nome = (
    p.product_name || p.name ||
    (fam === 'variable_income' && p.ticker) ||
    inv.investment_type || 'Investimento'
  ).toString().slice(0, 120);

  const rentabilidade = aportado && atual != null && aportado > 0
    ? Math.round(((atual - aportado) / aportado) * 10000) / 100   // %
    : 0;

  return {
    externalId: String(inv.id),
    tipo: tipoInvestimento(inv),
    nome,
    nome_completo: [p.name, p.isin_code, inv.investment_type, inv.brand_name]
      .filter(Boolean).join(' · ').slice(0, 200) || null,
    ticker: (p.ticker || null),
    quantidade,
    preco_unitario: precoUnit,
    valor_aportado: aportado,
    valor_atual: atual,
    rentabilidade,
    moeda: moeda(b.net_amount || b.gross_amount),
    data_compra: ymd(p.purchase_date) || ymd(b.reference_date_time || b.reference_date),
    data_vencimento: ymd(p.due_date),
    indexador: rem.indexer ? String(rem.indexer).replace(/_/g, ' ') : null,
    percentual_indexador: pct(rem.post_fixed_indexer_percentage),
    taxa_anual: pct(rem.pre_fixed_rate),
    setor: fam === 'fund' ? (inv.anbima_category || (p.anbima_category || null)) : null,
    sincronizado: !!(inv.balance),
  };
}

// ── Upserts na Sora ─────────────────────────────────────────────────────────

/** Cria/atualiza a wallet da conta ou cartão. Devolve o NOME (chave das transações). */
async function upsertWallet(grupoId, userId, n, saldo) {
  const nome = (n.nome || 'Conta').toString().trim().slice(0, 60);
  const extras = Object.fromEntries(Object.entries(n.extras || {}).filter(([, v]) => v != null));
  const patchSaldo = saldo == null ? {} : { saldo };

  // ⚠️ Se UMA coluna dos extras não existir (migration nova ainda não rodada), o
  // update inteiro falha — e levaria o SALDO junto, zerando a fatura na tela.
  // Por isso: tenta com tudo e, no erro, repete só com o essencial.
  const atualizar = async (id) => {
    const { error } = await supabase.from('wallets')
      .update({ tipo: n.tipo, ...patchSaldo, ...extras }).eq('id', id);
    if (error) await supabase.from('wallets').update({ tipo: n.tipo, ...patchSaldo }).eq('id', id);
  };

  const { data: ja } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).eq('of_conta_id', n.externalId).maybeSingle();
  if (ja) {
    await atualizar(ja.id);
    return ja.nome;
  }
  // Adota carteira manual de mesmo nome (evita duplicar o que o usuário já criou).
  const { data: mesmoNome } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).ilike('nome', nome).is('of_conta_id', null).maybeSingle();
  if (mesmoNome) {
    const vinculo = { of_conta_id: n.externalId, of_provider: PROVIDER };
    const { error } = await supabase.from('wallets')
      .update({ tipo: n.tipo, ...vinculo, ...patchSaldo, ...extras }).eq('id', mesmoNome.id);
    if (error) {
      await supabase.from('wallets')
        .update({ tipo: n.tipo, ...vinculo, ...patchSaldo }).eq('id', mesmoNome.id);
    }
    return mesmoNome.nome;
  }
  const row = {
    grupo_id: grupoId, nome, tipo: n.tipo, saldo: saldo ?? 0,
    of_conta_id: n.externalId, of_provider: PROVIDER, ...extras,
  };
  if (userId) row.criado_por = userId;
  let { data: nova, error } = await supabase.from('wallets').insert(row).select('nome').single();
  if (error) {
    // Nome duplicado no grupo → sufixa. Se falhar de novo, tenta sem os extras
    // (coluna que a migration ainda não criou não pode derrubar o sync).
    ({ data: nova, error } = await supabase.from('wallets')
      .insert({ ...row, nome: `${nome} (OF)`.slice(0, 60) }).select('nome').single());
    if (error) {
      const { grupo_id, criado_por, tipo, saldo: s, of_conta_id, of_provider } = row;
      ({ data: nova } = await supabase.from('wallets')
        .insert({ grupo_id, criado_por, nome: `${nome} (OF)`.slice(0, 60), tipo, saldo: s, of_conta_id, of_provider })
        .select('nome').single());
    }
  }
  return (nova && nova.nome) || nome;
}

/** Insere transações novas (dedup por of_tx_id). Devolve quantas entraram. */
async function inserirTransacoes(grupoId, userId, walletNome, txs) {
  const validas = txs.filter(Boolean);
  if (!validas.length) return 0;

  const ids = validas.map((t) => t.externalId);
  const existentes = new Set();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase.from('transacoes')
      .select('of_tx_id').in('of_tx_id', ids.slice(i, i + 300));
    (data || []).forEach((d) => existentes.add(d.of_tx_id));
  }

  let novas = validas.filter((t) => !existentes.has(t.externalId)).map((t) => ({
    id_curto: idCurto(), grupo_id: grupoId, criado_por: userId || null,
    tipo: t.ehGasto ? 'Gasto' : 'Recebimento',
    categoria: t.categoria || 'Outros',
    valor: t.valor,
    observacao: (t.descricao || '').slice(0, 200),
    carteira_nome: walletNome,
    pago: true,
    transferencia: !!t.transferencia,
    data: t.data,
    of_tx_id: t.externalId,
    of_card: t.card || null,
    of_bill_id: t.billId || null,
  }));
  if (!novas.length) return 0;

  // Regra do usuário manda sobre o motor de palavras (migration 104): se ele já
  // corrigiu "FernandoPeixoto" pra Autocuidado, a importação nova não volta pra
  // "Outros". Best-effort — sem a migration, segue com a categoria automática.
  try {
    const { aplicarRegrasEmLote } = require('./regrasCategoria');
    await aplicarRegrasEmLote(grupoId, novas);
  } catch { /* migration 104 pendente */ }

  // A cobrança real ASSUME a previsão da recorrência (mesma conta, valor e
  // data próximos) em vez de virar uma linha nova — senão o gasto conta duas
  // vezes: uma projetada pelo cron, outra importada do banco.
  try {
    const { reconciliar } = require('./reconciliarPrevisto');
    const r = await reconciliar(grupoId, novas);
    if (r.reconciliadas) novas = r.restantes;
    if (!novas.length) return r.reconciliadas;
  } catch { /* sem reconciliação: insere tudo, como antes */ }

  let { error } = await supabase.from('transacoes').insert(novas);
  // Coluna nova (migration 101) ainda não rodada: reinsere sem ela em vez de
  // deixar a sincronização inteira cair — o vínculo com a fatura é um extra.
  if (error && /of_bill_id/i.test(error.message || '')) {
    const semBill = novas.map(({ of_bill_id, ...r }) => r);
    ({ error } = await supabase.from('transacoes').insert(semBill));
    if (!error) return semBill.length;
  }
  if (error) {
    // Fallback 1 a 1 — a unique de of_tx_id ignora corrida entre syncs.
    let ok = 0;
    for (const row of novas) {
      let { error: e } = await supabase.from('transacoes').insert(row);
      if (e && /of_bill_id/i.test(e.message || '')) {
        const { of_bill_id, ...semBill } = row;
        ({ error: e } = await supabase.from('transacoes').insert(semBill));
      }
      if (!e) ok++;
    }
    return ok;
  }
  return novas.length;
}

/** Cria/atualiza a dívida (empréstimo/financiamento) vinda do OF. */
async function upsertDivida(grupoId, userId, d) {
  const base = {
    grupo_id: grupoId, titulo: d.titulo, credor: d.credor, tipo: d.tipo,
    valor_total: d.valor_total, valor_parcela: d.valor_parcela,
    parcelas_total: d.parcelas_total, parcelas_pagas: d.parcelas_pagas,
    taxa_juros: d.taxa_juros, indexador: d.indexador,
    dia_vencimento: d.dia_vencimento, data_inicio: d.data_inicio,
    data_quitacao: d.data_quitacao, status: d.status, observacao: d.observacao,
  };

  const { data: ja } = await supabase.from('dividas')
    .select('id').eq('grupo_id', grupoId).eq('of_id', d.externalId).maybeSingle();
  if (ja) {
    await supabase.from('dividas').update(base).eq('id', ja.id);
    return 'atualizada';
  }
  const row = { ...base, of_id: d.externalId, of_provider: PROVIDER, origem: 'of' };
  if (userId) row.criado_por = userId;
  let { error } = await supabase.from('dividas').insert(row);
  if (error && /of_id|of_provider|origem/i.test(error.message || '')) {
    // Migration 100 ainda não rodou: grava sem os campos OF (sem dedup, mas o
    // usuário vê a dívida). O aviso sai no retorno do sync.
    ({ error } = await supabase.from('dividas').insert({ ...base, criado_por: userId || null }));
    if (!error) return 'sem_migration';
  }
  if (error) throw new Error(`dívida: ${error.message}`);
  return 'criada';
}

/** Cria/atualiza o investimento vindo do OF. */
async function upsertInvestimento(grupoId, n) {
  const base = {
    grupo_id: grupoId, tipo: n.tipo, nome: n.nome, ticker: n.ticker,
    quantidade: n.quantidade, preco_unitario: n.preco_unitario,
    valor_aportado: n.valor_aportado, valor_atual: n.valor_atual,
    rentabilidade: n.rentabilidade, moeda: n.moeda,
    data_compra: n.data_compra, data_vencimento: n.data_vencimento,
    indexador: n.indexador, percentual_indexador: n.percentual_indexador,
    taxa_anual: n.taxa_anual, nome_completo: n.nome_completo, setor: n.setor,
    ultima_atualizacao: new Date().toISOString(),
  };
  const limpo = Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined));

  const { data: ja } = await supabase.from('investimentos')
    .select('id').eq('grupo_id', grupoId).eq('of_id', n.externalId).maybeSingle();
  if (ja) {
    await supabase.from('investimentos').update(limpo).eq('id', ja.id);
    return 'atualizado';
  }
  const { error } = await supabase.from('investimentos')
    .insert({ ...limpo, of_id: n.externalId, of_provider: PROVIDER, origem: 'of' });
  if (error) throw new Error(`investimento: ${error.message}`);
  return 'criado';
}

// ── Orquestração ────────────────────────────────────────────────────────────

/**
 * Sincroniza um consentimento inteiro. Cada bloco é tolerante: falha numa parte
 * não derruba o resto (e o motivo vai no relatório).
 *
 * @param {string} consentId  id do consentimento na Polp
 * @param {object} opts       { dias = 90 } janela de transações
 */
async function sincronizarConsentimento(consentId, { dias = 90 } = {}) {
  const { data: conexao } = await supabase.from('of_conexoes')
    .select('*').eq('provider', PROVIDER).eq('external_id', String(consentId)).maybeSingle();
  if (!conexao) return { erro: 'conexão desconhecida' };

  const { grupo_id: grupoId, user_id: userId } = conexao;
  const hoje = hojeSP();
  const fromDate = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const relatorio = { contas: [], cartoes: [], dividas: [], investimentos: [], avisos: [] };

  // 1. Estado do consentimento. Sem AUTHORISED não há dado pra importar.
  let consent = null;
  try { consent = await celcoin.getConsentimento(consentId); }
  catch (e) { relatorio.avisos.push(`status: ${e.message}`); }

  const status = ((consent && consent.status) || '').toString().toUpperCase();
  if (status && status !== 'AUTHORISED') {
    await supabase.from('of_conexoes').update({
      status: status.toLowerCase(),
      ultimo_erro: status === 'REJECTED' ? 'Autorização recusada no banco. Conecte de novo.'
        : status === 'EXPIRED' ? 'Consentimento expirado. Conecte de novo.' : null,
    }).eq('id', conexao.id);
    return {
      pendente: status,
      urlToAuthenticate: (consent && consent.url_to_authenticate) || null,
      novas: 0,
    };
  }

  try {
    let novasTx = 0;

    // 2. CONTAS → wallet + transações
    for (const raw of await celcoin.listarContas(consentId)) {
      try {
        const n = normalizeConta(raw);
        const walletNome = await upsertWallet(grupoId, userId, n, n.saldo);
        const txs = await celcoin.listarTransacoesConta(n.externalId, { fromDate });
        const novas = await inserirTransacoes(grupoId, userId, walletNome, txs.map(normalizeTxConta));
        novasTx += novas;
        relatorio.contas.push({
          conta: walletNome, saldo: n.saldo, txs: txs.length, novas,
          pendente_sync: !n.sincronizado || undefined,
        });
      } catch (e) { relatorio.contas.push({ erro: e.message }); }
    }

    // 3. CARTÕES → wallet 'Crédito' + fatura (datas reais!) + transações
    for (const raw of await celcoin.listarCartoes(consentId)) {
      try {
        const bills = await celcoin.listarFaturas(raw.id);
        const n = normalizeCartao(raw, bills, hoje);
        const walletNome = await upsertWallet(grupoId, userId, n, n.saldoFatura);

        const txs = await celcoin.listarTransacoesCartao(n.externalId, { fromDate });
        const normalizadas = txs.map((t) => normalizeTxCartao(t, hoje));
        const novas = await inserirTransacoes(grupoId, userId, walletNome, normalizadas);
        novasTx += novas;

        // ⚠️ A fatura AINDA ABERTA quase nunca tem `bill_total_amount` — o banco
        // só publica o total quando ela FECHA. Aí vale a REGRA DE OURO:
        //
        //     fatura = limite usado − parcelas a vencer
        //
        // NÃO some as transações importadas aqui. As parcelas que compõem a
        // fatura aberta só chegam quando ela é publicada, então a soma sai
        // sempre a MENOS (medido: R$ 1.870,24 numa fatura real de R$ 3.423,57).
        // A soma por transação fica como último recurso, pra emissor que não
        // informa limite usado.
        if (!(n.faturaAberta && n.faturaAberta.total > 0)) {
          // Parcela a vencer = transação com data no FUTURO. Medida, nunca
          // projetada (projetar já deu 6.379 onde o real era 2.504).
          const futuras = cent((txs || []).reduce((s, t) => {
            const d = ymd(t.transaction_date_time || t.bill_post_date);
            if (!d || d <= hoje) return s;
            const v = money(t.brazilian_amount) ?? money(t.amount);
            const credito = (t.credit_debit_type || '').toString().toUpperCase() === 'CREDITO';
            return (v == null || credito) ? s : s + Math.abs(v);
          }, 0));

          // ⚠️ O LIMITE USADO **NÃO** É A FATURA — e não dá pra converter um no
          // outro com o que o emissor entrega. Medido num Nubank real:
          //   limite usado 4.061,99 · fatura no app 3.423,57 → sobram 638,42
          // de parcelas de faturas FUTURAS ocupando limite hoje. Pra descontar,
          // precisaríamos saber quais são, e nenhuma fonte serve:
          //   · transações com data futura: a Celcoin manda parcela com a data
          //     da COMPRA, então vieram ZERO;
          //   · `parcelamentos`: devolve o mesmo parcelamento DUPLICADO (três
          //     linhas pro mesmo Mercado Livre, com paidInstallments 5, 3 e 1) —
          //     somando dá 2.887,67 ou 1.159,49 conforme a leitura, nenhuma
          //     perto de 638,42.
          // Ficar procurando a combinação que fecha é ajustar número até bater,
          // e isso com dinheiro na tela do cliente não se faz.
          //
          // Então a fatura em aberto sai do que dá pra AUDITAR: as transações
          // que o próprio usuário vê na lista logo abaixo do valor. Sai a menos
          // quando há parcelamento (a parcela desta fatura vem com a data da
          // compra) — e a tela diz isso, em vez de exibir um número redondo e
          // errado. O limite usado vai pra barra de limite, que é o lugar dele.
          const estimada = faturaPorTransacoes(normalizadas, txs, n, hoje);
          const fonte = n.fonteFatura || 'ciclo';

          if (estimada != null) {
            const pago = n.faturaAberta ? n.faturaAberta.pago : 0;
            const restante = Math.max(0, cent(estimada - pago));
            await upsertWallet(grupoId, userId, n, -restante);
            relatorio.avisos.push(
              `${walletNome}: banco não publicou o total da fatura em aberto — somada por ${fonte} = R$ ${restante.toFixed(2)}` +
              ` · limite usado informado pelo emissor: ${n.limiteUsado == null ? 'não informado' : `R$ ${Number(n.limiteUsado).toFixed(2)}`}` +
              (futuras ? ` · parcelas datadas no futuro: R$ ${futuras.toFixed(2)}` : ''));
            if (n.faturaAberta) { n.faturaAberta.total = estimada; n.faturaAberta.fonte = fonte; }
            else n.faturaAberta = { estimada: true, restante, fonte };
          }
        }

        relatorio.cartoes.push({
          cartao: walletNome, limite: n.extras.limite,
          fatura: n.faturaAberta, estimada: estimada != null || undefined,
          txs: txs.length, novas,
        });
      } catch (e) { relatorio.cartoes.push({ erro: e.message }); }
    }

    // 4. EMPRÉSTIMOS + FINANCIAMENTOS → aba Dívidas
    for (const [kind, lista] of [
      ['emprestimo', await celcoin.listarEmprestimos(consentId)],
      ['financiamento', await celcoin.listarFinanciamentos(consentId)],
    ]) {
      for (const raw of lista) {
        try {
          const d = normalizeDivida(raw, kind);
          if (!d) { relatorio.dividas.push({ pulado: 'sem valor contratado', id: raw.id }); continue; }
          const r = await upsertDivida(grupoId, userId, d);
          if (r === 'sem_migration') relatorio.avisos.push('rode sql/100_dividas_open_finance.sql (dívidas sem dedup até então)');
          relatorio.dividas.push({ titulo: d.titulo, tipo: d.tipo, valor: d.valor_total, resultado: r });
        } catch (e) { relatorio.dividas.push({ erro: e.message }); }
      }
    }

    // 5. INVESTIMENTOS (5 famílias) → aba Investimentos
    for (const raw of await celcoin.listarInvestimentos(consentId)) {
      try {
        const n = normalizeInvestimento(raw);
        if (n.valor_atual == null) {
          relatorio.investimentos.push({ pulado: 'saldo ainda não sincronizado', nome: n.nome });
          continue;
        }
        const r = await upsertInvestimento(grupoId, n);
        relatorio.investimentos.push({ nome: n.nome, tipo: n.tipo, valor: n.valor_atual, resultado: r });
      } catch (e) { relatorio.investimentos.push({ erro: e.message }); }
    }

    await supabase.from('of_conexoes').update({
      status: 'updated', ultima_sync: new Date().toISOString(), ultimo_erro: null,
    }).eq('id', conexao.id);

    // Limite de gasto: com o Open Finance a maior parte das despesas passa a
    // entrar por AQUI, e o alerta de teto não existia neste caminho.
    // Chamado UMA vez no fim do sync, não por transação: a dedup do serviço já
    // garante um aviso por limite por mês, mas chamar a cada linha importada
    // seria dezenas de leituras à toa.
    if (novasTx > 0) {
      require('./limites').verificarLimiteEmBackground(grupoId, null);
    }

    return { novas: novasTx, ...relatorio };
  } catch (e) {
    await supabase.from('of_conexoes').update({
      status: 'error', ultimo_erro: String(e.message).slice(0, 300),
    }).eq('id', conexao.id);
    return { erro: e.message, ...relatorio };
  }
}

module.exports = {
  PROVIDER,
  sincronizarConsentimento,
  // expostos pra teste/diagnóstico (puros, sem banco)
  money, pct, cetParaMensal, diaDoMes, categoriaDe,
  ehPagamentoFatura: require('./categorizar').ehPagamentoFatura,
  normalizeConta, normalizeCartao, normalizeTxConta, normalizeTxCartao, faturaPorTransacoes,
  normalizeDivida, normalizeInvestimento, ultimaFaturaPublicada, faturaPorLimite,
  limiteTotalDoCartao, escolherFaturaAberta, pagoDaFatura, tipoInvestimento,
  analisarParcelamentos, normalizeParcelamento, assinaturaCompra,
};
