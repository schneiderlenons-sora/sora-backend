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
const crypto   = require('crypto');
const supabase = require('../db/supabase');
const celcoin  = require('./polpCelcoin');
const {
  categorizarDescricao, mapearCategoriaPluggy, CATEGORIA_FATURA, CATEGORIA_ESTORNO,
  ehPagamentoFaturaDescricao,
} = require('./categorizar');
const { cicloPorCompetencia, competenciaAtual, hojeSP } = require('./cicloFatura');
const { valorNaFatura } = require('./valorFatura');
const { registrarPagamentosDoOF } = require('./faturaRollover');
const { gravarParcelasPrevistas } = require('./parcelasPrevistas');
const { salvarFaturas } = require('./faturasBanco');

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

// ⚠️ `ehGasto` NÃO é opcional na prática: sem ele o Pix enviado volta a
// receber a categoria de receita. Ver `ajustarPorDirecao`.
function categoriaDe(descricao, categoryRef, ehGasto) {
  const { ajustarPorDirecao } = require('./categorizar');
  return ajustarPorDirecao(categoriaBruta(descricao, categoryRef), ehGasto);
}

function categoriaBruta(descricao, categoryRef) {
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

function normalizeConta(acc, instituicao) {
  const ident = acc.identification || {};
  const bal   = acc.balance || null;
  const over  = acc.overdraft_limit || null;
  const tipo  = TIPO_CONTA[ident.type || acc.type] || 'Corrente';

  // Nome: a conta não tem "nome" no Open Finance — montamos com o banco + tipo.
  //
  // ⚠️ `brand_name` VEM VAZIO em parte das contas, e aí a carteira nascia
  // chamada literalmente "Banco" (medido: 4 carteiras assim, com 779
  // transações — virou relato de cliente). O consentimento SABE de que
  // instituição se trata (`of_conexoes.instituicao`), então ela entra como
  // 2º recurso; "Banco" só sobra quando nem isso existe.
  const banco = (acc.brand_name || instituicao || 'Banco').toString().trim();
  const sufixo = tipo === 'Poupança' ? ' Poupança' : '';
  const nome = `${banco}${sufixo}`.slice(0, 60);

  // ── SALDO = disponível + APLICAÇÃO AUTOMÁTICA ─────────────────────────────
  //
  // ⚠️ A doc da Celcoin diz que `available_amount` "não inclui cheque especial,
  // investimentos automáticos nem reservas de saldo". Bancos como o Itaú jogam
  // quase todo o saldo numa aplicação automática que volta sozinha quando o
  // cliente gasta — então `available_amount` fica quase zerado e NÃO é o saldo
  // que ele vê no app.
  //
  // MEDIDO na conta de um cliente (diagnóstico ?foco=saldo):
  //     available_amount ............... R$     1,00   ← era só isto que entrava
  //     automatically_invested_amount .. R$ 2.541,17
  //     app do Itaú mostrava ........... R$ 2.541,12
  // O painel exibia R$ 1,00 e ele abriu chamado dizendo que o saldo estava
  // errado. Estava: o dinheiro existia, só não era somado.
  //
  // ⚠️ NÃO DUPLICA COM A ABA INVESTIMENTOS — conferido na mesma conta: as 11
  // posições importadas (CDBs, fundos, Tesouro) não incluem a aplicação
  // automática. Ela é produto DA CONTA, e por isso vem em `balance` e não pela
  // API de investimentos.
  //
  // `blocked_amount` continua FORA: bloqueado não é gastável.
  //
  // ⚠️⚠️ MAS TEM EMISSOR QUE NÃO CUMPRE O CONTRATO. O Mercado Pago manda O
  // MESMO DINHEIRO nos dois campos, e aí a soma DOBRA o saldo do cliente:
  // painel R$ 4.414,32 contra R$ 2.207,16 no app. A aritmética não deixa outra
  // leitura — se `disponível + aplicado = 4.414,32` e o certo é exatamente
  // metade, então os dois campos valem 2.207,16 cada.
  //
  // O sinal é a IGUALDADE AO CENTAVO. Em conta de pagamento (o MP é uma) o
  // saldo inteiro rende, então os dois campos coincidirem é ESTRUTURAL, não
  // coincidência. E quando for coincidência de verdade, o erro é pro lado
  // seguro: mostra o disponível, que é o comportamento de antes — nunca
  // dinheiro que o cliente não tem.
  const disponivel = bal ? money(bal.available_amount) : null;
  const aplicado   = bal ? money(bal.automatically_invested_amount) : null;
  const dobrado = disponivel != null && aplicado != null
    && cent(disponivel) === cent(aplicado) && cent(aplicado) !== 0;
  const somaAplicado = dobrado ? 0 : (aplicado || 0);
  // `null` só quando NADA veio — senão uma conta sem aplicação automática
  // apareceria como "ainda não sincronizada".
  const saldo = (disponivel == null && aplicado == null)
    ? null
    : cent((disponivel || 0) + somaAplicado);

  return {
    externalId: String(acc.id),
    nome,
    tipo,
    saldo,                                 // null = ainda não sincronizado
    moeda: ident.currency || moeda(bal && bal.available_amount),
    extras: {
      // Cheque especial contratado (a Sora já tem esse conceito — migration 094).
      cheque_especial: over ? money(over.overdraft_contracted_limit) : null,
      // Quanto do saldo está aplicado. A tela usa pra explicar "dos quais R$ X
      // aplicados", em vez de o número simplesmente mudar sem motivo aparente.
      saldo_aplicado: aplicado,
    },
    sincronizado: !!bal,
  };
}

// ── Normalização: CAIXINHA (saldo reservado) ────────────────────────────────
//
// "Caixinhas" do Nubank e cofrinhos afins. Esse dinheiro **não está** no saldo
// da conta: a doc de `GET /accounts/{id}` diz que `balance.available_amount`
// "não inclui cheque especial, investimentos automáticos nem reservas de
// saldo". Então somar a caixinha à parte NÃO duplica — pelo contrário, sem
// isso o dinheiro não aparecia em lugar nenhum do painel.
//
// ⚠️ `available_amount` é um **ARRAY**, não um valor. A doc descreve "saldos
// disponíveis na reserva", cada item `{ amount, currency, remuneration? }` —
// ler `available_amount.amount` direto devolveria `undefined` e a caixinha
// entraria zerada. Somamos todos os itens.
//
// ⚠️ `amount` vem como STRING com 2 a 4 casas ("1000.0400"). `money()` já
// converte; o `cent()` no fim é que impede a quarta casa de virar centavo
// fantasma na soma.
function normalizeCaixinha(r, ofContaId) {
  // O id estável é `reserved_identification` (UUID no Open Finance). O campo
  // `id` é "identificador INTERNO da reserva" na Polp — não serve como chave
  // de dedup entre syncs.
  const externalId = r.reserved_identification || (r.id != null ? String(r.id) : null);
  if (!externalId) return null;

  const itens = Array.isArray(r.available_amount)
    ? r.available_amount
    : (r.available_amount ? [r.available_amount] : []);

  const saldo = cent(itens.reduce((s, a) => s + (money(a) ?? 0), 0));

  // A remuneração fica em cada item; pegamos a primeira que existir (uma
  // caixinha rende de um jeito só — múltiplos itens são moedas/faixas).
  const rem = (itens.find((a) => a && a.remuneration) || {}).remuneration || null;

  return {
    externalId: String(externalId),
    of_conta_id: ofContaId ? String(ofContaId) : null,
    // `reserved_name` é null quando o usuário não nomeou a reserva.
    nome: (r.reserved_name || 'Caixinha').toString().trim().slice(0, 120),
    tipo: 'caixinha',
    saldo,
    moeda: (itens.find((a) => a && a.currency) || {}).currency || 'BRL',
    indexador: rem && rem.indexer ? String(rem.indexer).replace(/_/g, ' ') : null,
    indexador_pct: rem ? pct(rem.post_fixed_indexer_percentage) : null,
    taxa_pre: rem ? pct(rem.pre_fixed_rate) : null,
    rate_type: (rem && rem.rate_type) || null,
    periodicidade: (rem && rem.rate_periodicity) || null,
    calculo: (rem && rem.calculation) || null,
    atualizado_em: r.updated_at || null,
  };
}

// ── Normalização: CARTÃO ────────────────────────────────────────────────────
const BANDEIRA = {
  VISA: 'Visa', MASTERCARD: 'Mastercard', ELO: 'Elo', HIPERCARD: 'Hipercard',
  AMERICAN_EXPRESS: 'Amex', DINERS_CLUB: 'Diners',
};

// ── LIMITE DO CARTÃO ───────────────────────────────────────────────────────
/**
 * VISÃO GERAL do grupo abaixo (`usoConhecido`, `limitePorModalidade`,
 * `tetoEfetivo` e `limiteTotalDoCartao`).
 *
 * Limite TOTAL do cartão. `limits[]` traz uma linha por modalidade
 * (CREDITO_A_VISTA, CREDITO_PARCELADO, SAQUE_*) e por consolidação
 * (CONSOLIDADO/INDIVIDUAL). O limite do cartão é o LIMITE_CREDITO_TOTAL;
 * preferimos CONSOLIDADO quando existe (é o teto do cartão inteiro).
 *
 * ⚠️ SEM `LIMITE_CREDITO_TOTAL` existe um SEGUNDO caminho, mas ele NÃO é "o
 * maior `limit_amount` que houver" — ver `limitePorModalidade` logo abaixo.
 *
 * O fallback antigo era esse "maior que houver", e produziu um número
 * claramente errado num Nubank real: o cartão mandou UMA única linha,
 * `LIMITE_CREDITO_MODALIDADE_OPERACAO` / `line_name: OUTROS` /
 * `line_name_additional_info: "Limite Nupay"`, com limite R$ 300,45. O painel
 * passou a exibir "limite R$ 300,45 · usado R$ 300,45 (100%)" num cartão cuja
 * fatura daquele mês foi R$ 2.293,71 — ou seja, uma sub-modalidade do NuPay
 * virou o teto do cartão inteiro.
 *
 * A regra que ficou no lugar dele é estreita e tem uma trava aritmética: o
 * candidato é recusado se for menor do que a fatura do próprio cartão. Preferir
 * "não sei" a um teto falso continua valendo — limite errado contamina a barra
 * de uso e o alerta de limite estourado.
 */

/**
 * Maior gasto CONHECIDO do cartão — a régua da trava anti-sublimite.
 *
 * ⚠️ NÃO usa `used_amount` de propósito. No caso do "Limite Nupay" ele vinha
 * IGUAL ao sublimite (300,45 usado de 300,45 de teto), então comparar um com o
 * outro não separa nada. Quem denuncia o sublimite é a FATURA, que vem de
 * outra fonte: as bills publicadas e a simulada.
 */
function usoConhecido(card, bills) {
  const vals = (Array.isArray(bills) ? bills : [])
    .map((b) => money(b && b.bill_total_amount))
    .filter((v) => v != null);
  // ⚠️ O `unbilled_amount` NÃO é a fatura (ver `faturaPorLimite`), mas É gasto
  // real: dinheiro que já ocupa limite e ainda não entrou em fatura nenhuma.
  // Como PISO da régua ele vale, e é o único piso que existe num cartão que o
  // emissor ainda não publicou fatura — justamente o caso mais comum logo
  // depois de conectar. Tirá-lo daqui fazia a trava recusar o limite desses
  // cartões por falta de régua, e o limite não aparecia.
  const unb = unbilledDoCartao(card);
  if (unb != null) vals.push(unb);
  const sim = faturaSimulada(card);          // legado, pra payload antigo
  if (sim != null) vals.push(sim);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Candidato quando o emissor NÃO publica `LIMITE_CREDITO_TOTAL`.
 *
 * Medido em ago/2026: dos 29 cartões de Open Finance da base, os 10 que estão
 * sob conexão Nubank não recebem NENHUMA linha `LIMITE_CREDITO_TOTAL` — só
 * `MODALIDADE_OPERACAO`. BRB, Inter, BTG e Mercado Pago mandam o total normal.
 * Recusar tudo que não fosse TOTAL deixava 72% dos cartões sem limite nenhum.
 *
 * Duas travas, e é a segunda que impede a volta do bug do NuPay:
 *  1. Todas as linhas de modalidade têm de CONCORDAR no teto. Se divergem, são
 *     sublimites de modalidades diferentes (saque, parcelado…) e nenhuma delas
 *     é o teto do cartão.
 *  2. O teto não pode ser MENOR do que o que já se gastou no cartão. Limite
 *     total abaixo da própria fatura é impossível — foi exatamente assim que o
 *     "Limite Nupay" de R$ 300,45 virou o teto de um cartão cuja fatura do mês
 *     era R$ 2.293,71.
 */
function limitePorModalidade(arr, usoRef, diag) {
  const anota = (motivo) => { if (diag) diag.motivo = motivo; return null; };

  const mods = arr.filter((l) => l && l.credit_line_limit_type === 'LIMITE_CREDITO_MODALIDADE_OPERACAO');
  if (!mods.length) return anota('nenhuma linha de modalidade em limits[]');

  const tetos = new Set(mods.map((l) => String(money(l.limit_amount))));
  if (tetos.size !== 1) {                               // trava 1
    return anota(`linhas de modalidade DISCORDAM do teto (${[...tetos].join(' × ')})`);
  }

  const teto = money(mods[0].limit_amount);
  if (teto == null || teto <= 0) return anota(`teto ausente ou <= 0 (${teto})`);
  // trava 2 — ⚠️ SEM RÉGUA TAMBÉM NÃO ADOTA (`usoRef == null`). Cartão sobre o
  // qual não sabemos nada do gasto é o caso mais cego; adotar ali reabriria o
  // bug do NuPay por outra porta.
  if (usoRef == null) return anota('sem régua de gasto conhecido pra conferir o teto');
  if (teto < usoRef) return anota(`teto ${teto} MENOR que o gasto conhecido ${usoRef} — impossível`);

  if (diag) diag.motivo = null;
  return mods[0];
}

/**
 * Qual dos dois tetos a pessoa REALMENTE tem.
 *
 * O banco manda os dois: `limit_amount` é o que ele CONCEDEU e
 * `customized_limit_amount` é o que o cliente DEIXOU ativo. Confirmado com a
 * titular de um Nubank real: o app dela mostra 10.050 concedidos e 6.050
 * configurados por ela.
 *
 * ⚠️ O desempate NÃO é preferência nossa — é o `available_amount` do próprio
 * banco. Vale o teto que satisfaz `teto − usado = disponível`, porque é ele
 * que faz a barra do painel bater com a tela do app. Nesse cartão:
 *    6.050,00 − 3.155,80 = 2.894,20  ✅ = available_amount
 *   10.050,00 − 3.155,80 = 6.894,20  ❌ mostraria R$ 4.000 de limite que ela
 *                                       não pode gastar — e erra pro lado que
 *                                       faz alguém passar o cartão achando que cabe.
 */
function tetoEfetivo(l, usado, disponivel) {
  const concedido   = money(l.limit_amount);
  const configurado = money(l.customized_limit_amount);
  if (disponivel != null && usado != null) {
    // Tolerância de R$ 1: o banco arredonda (mandou 2894.1976 pra 2894,20) e
    // os dois candidatos distam milhares, então não há como confundi-los.
    const bate = (v) => v != null && Math.abs((v - usado) - disponivel) <= 1;
    if (bate(configurado)) return configurado;
    if (bate(concedido))   return concedido;
  }
  return configurado ?? concedido;
}

function limiteTotalDoCartao(limits, usoRef = null) {
  // `respondeu` separa "o banco disse que não tem limite total" de "o banco
  // ainda não sincronizou os limites" (a doc avisa: `limits` pode vir null).
  // É o que permite LIMPAR um limite errado sem apagar um limite bom quando a
  // resposta simplesmente não veio — ver `extras` em normalizeCartao.
  const respondeu = Array.isArray(limits) && limits.length > 0;
  const arr = Array.isArray(limits) ? limits : [];
  const totais = arr.filter((l) => l && l.credit_line_limit_type === 'LIMITE_CREDITO_TOTAL');
  // `motivo` explica a RECUSA no diagnóstico. Sem ele, "limite não veio" era
  // indistinguível de "limite recusado por trava" e a investigação virava
  // adivinhação — foi o que aconteceu quando um Nubank sincronizou sem limite.
  const diag = { motivo: 'limits[] vazio ou ausente' };
  const escolhido =
    totais.find((l) => l.consolidation_type === 'CONSOLIDADO') ||
    totais[0] ||
    limitePorModalidade(arr, usoRef, diag) ||
    null;
  if (totais.length) diag.motivo = null;
  if (!escolhido) return { limite: null, usado: null, disponivel: null, respondeu, motivo: diag.motivo, usoRef };
  const usado = money(escolhido.used_amount);
  const disponivel = money(escolhido.available_amount);
  return {
    limite: tetoEfetivo(escolhido, usado, disponivel),
    usado,
    disponivel,
    respondeu,
  };
}

/** Total já pago numa fatura (soma de payments[]). */
function pagoDaFatura(bill) {
  return cent((bill && Array.isArray(bill.payments) ? bill.payments : [])
    .reduce((s, p) => s + money0(p && p.amount !== undefined ? p.amount : p), 0));
}

/**
 * Fatura SIMULADA — o campo novo da Polp (ago/2026), que vale pra todos os
 * bancos: quanto a fatura EM ANDAMENTO daria se fechasse agora.
 *
 * É exatamente o número que faltava. Até aqui, no trilho Celcoin, a fatura em
 * aberto tinha de ser somada das transações do ciclo, porque o emissor só
 * publica `bill_total_amount` DEPOIS que a fatura fecha (ver CLAUDE.md). O
 * simulado resolve isso na fonte — e já vem líquido de pagamentos, então
 * também conserta o caso "paguei a fatura e o painel não atualizou".
 *
 * Procura em vários lugares porque a Polp ainda está estabilizando o contrato
 * e o campo pode vir na fatura OU no cartão. `null` = não veio; nada muda.
 */
function faturaSimulada(fonte) {
  if (!fonte || typeof fonte !== 'object') return null;
  const v = fonte.simulated_bill_total_amount != null
    ? fonte.simulated_bill_total_amount
    : (fonte.simulatedBillTotalAmount != null ? fonte.simulatedBillTotalAmount : null);
  const n = money(v);
  // Zero é resposta VÁLIDA (fatura quitada) — só descarta o que não veio.
  return n == null ? null : Math.max(0, n);
}

/**
 * Fatura em curso pelo campo NOVO da Celcoin — `unbilled_amount`.
 *
 * ⚠️ BREAKING CHANGE DA POLP EM 24/08/2026: `simulated_bill_total_amount` foi
 * REMOVIDO da raiz do cartão (e das faturas — sumiu de todos os 35 docs). No
 * lugar, cada item de `limits[]` ganhou `unbilled_amount`, definido como "soma
 * do `brazilian_amount` das transações com `bill_id` null e `bill_post_date`
 * posterior a `bill_closing_date + 1 mês`, filtradas pelo
 * `identification_number` daquele limite".
 *
 * Ou seja: o valor deixou de ser do CARTÃO e passou a ser por PLÁSTICO
 * (titular, adicional, virtual). Sem esta função o `faturaSimulada` devolveria
 * null pra todo mundo e a fonte nº 2 do `faturaVista` morreria calada — o
 * painel cairia no fallback de somar transações, que é justamente o que erra
 * quando falta lançamento.
 *
 * ⚠️ SOMA POR `identification_number` DISTINTO, não linha a linha. O mesmo
 * plástico aparece em mais de uma linha de `limits[]` (uma por modalidade), e
 * somar cada linha contaria o mesmo cartão duas vezes — no cartão medido são
 * duas linhas idênticas por plástico. Linhas sem `identification_number`
 * colapsam numa chave só, pra nunca inflar.
 *
 * ⚠️ `null` ≠ `0`. A doc diz que o campo vem null quando o cartão não tem
 * fatura com data de fechamento; virar R$ 0,00 ali é a mentira de "fatura
 * zerada" que já custou um diagnóstico inteiro. Só devolve número quando ao
 * menos uma linha respondeu.
 *
 * ⚠️⚠️ A SOMA É PROVISÓRIA — A PRÓPRIA POLP DESACONSELHA (25/08/2026).
 *
 * Resposta deles, textual: "não recomendamos assumir que a soma de todos os
 * unbilled_amount das linhas seja necessariamente o valor correto do cartão
 * como um todo, justamente por causa desses sub-limites". E completam que não
 * recebem do banco, de forma clara, o limite total do cartão, e que ainda
 * estão ajustando como interpretar essas linhas "para evitar somar linhas que
 * podem representar limites específicos e acabar duplicando ou distorcendo o
 * unbilled_amount".
 *
 * POR QUE A SOMA CONTINUA AQUI ASSIM MESMO: nos dois cartões que hoje fecham
 * no centavo com o app do banco (um Nubank e um Mercado Pago), só UMA linha
 * tem `unbilled_amount` diferente de zero — a soma nunca chega a somar nada de
 * fato. Trocar a regra agora seria calibrá-la no cartão que NÃO fecha e
 * arriscar os dois que fecham.
 *
 * O caso que expõe o problema (Nubank final 3456): duas modalidades reais,
 * "saque nacional e internacional" (unbilled 108,76) e "Limite Pix no Crédito"
 * (unbilled 2.036,49 com teto de 204,34 — dez vezes o próprio limite da
 * linha). Somando dá 2.145,25, e a fatura do banco exigiria 2.342,17. Ali a
 * regra de ouro nem roda, porque `usadoDoCartao` recusa quando as linhas
 * divergem no `used_amount`.
 *
 * PENDENTE: a Polp vai voltar com a interpretação correta. Quando vier,
 * trocar esta agregação — e conferir os DOIS cartões que já fecham antes de
 * subir, não só o que está errado.
 */
/**
 * `used_amount` do CARTÃO, lido DIRETO de `limits[]`.
 *
 * ⚠️ POR QUE NÃO REUSAR O `usado` QUE SAI DO `limiteTotalDoCartao`: aquele vem
 * da linha que venceu a disputa do TETO, e adotar um teto é decisão de
 * EXIBIÇÃO (não mostrar limite falso — ver o caso do "Limite Nupay"). O
 * `used_amount` é um FATO do banco. Amarrar um no outro deixou o Mercado Pago
 * SEM FATURA: como o teto dele é recusado pela trava, `usado` vinha null, a
 * regra de ouro não rodava, e a fatura caía na soma das transações — que sai a
 * menos quando há parcelamento. Medido: 1.925,68 contra 2.325,30 do banco.
 *
 * ⚠️ SÓ DEVOLVE QUANDO TODAS AS LINHAS CONCORDAM. Nos payloads reais o
 * `used_amount` vem IGUAL em toda linha de `limits[]` — é do cartão inteiro,
 * não da modalidade. Quando divergem não há como saber qual é o do cartão, e
 * escolher uma produz o absurdo que apareceu na tela de um cliente: "limite
 * R$ 4.750 · usado R$ 4.836,77", com o teto de uma linha e o usado de outra.
 * Preferir não calcular a calcular errado.
 */
function usadoDoCartao(card) {
  const arr = Array.isArray(card && card.limits) ? card.limits : [];

  // Se o emissor publica a linha do CARTÃO INTEIRO, o `used_amount` dela é o do
  // cartão por definição — não precisa de consenso com as modalidades, que
  // podem legitimamente ter usados diferentes. Sem este ramo, todo cartão com
  // TOTAL + modalidades perderia a regra de ouro que já funciona hoje.
  const totais = arr.filter((l) => l && l.credit_line_limit_type === 'LIMITE_CREDITO_TOTAL');
  const doTotal = totais.find((l) => l.consolidation_type === 'CONSOLIDADO') || totais[0] || null;
  if (doTotal) {
    const v = money(doTotal.used_amount);
    if (v != null) return cent(v);
  }

  const vals = arr.map((l) => money(l && l.used_amount)).filter((v) => v != null);
  if (!vals.length) return null;
  return new Set(vals.map((v) => cent(v))).size === 1 ? cent(vals[0]) : null;
}

function unbilledDoCartao(card) {
  const arr = Array.isArray(card && card.limits) ? card.limits : [];

  // Simétrico ao `usadoDoCartao`: existindo a linha do CARTÃO INTEIRO, o
  // `unbilled_amount` dela é o do cartão. Sem este ramo o resultado dependia da
  // ORDEM em que o banco manda as linhas (as sem `identification_number`
  // colapsam na primeira), o que é frágil demais pra um número de dinheiro.
  const totais = arr.filter((l) => l && l.credit_line_limit_type === 'LIMITE_CREDITO_TOTAL');
  const doTotal = totais.find((l) => l.consolidation_type === 'CONSOLIDADO') || totais[0] || null;
  if (doTotal) {
    const v = money(doTotal.unbilled_amount != null ? doTotal.unbilled_amount : doTotal.unbilledAmount);
    if (v != null) return Math.max(0, cent(v));
  }

  const porPlastico = new Map();
  for (const l of arr) {
    if (!l) continue;
    const v = money(l.unbilled_amount != null ? l.unbilled_amount : l.unbilledAmount);
    if (v == null) continue;
    const chave = l.identification_number != null ? String(l.identification_number) : '__sem_id';
    if (!porPlastico.has(chave)) porPlastico.set(chave, v);
  }
  if (!porPlastico.size) return null;
  const total = [...porPlastico.values()].reduce((s, v) => s + v, 0);
  return Math.max(0, cent(total));
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
 * Dia do mês MAIS FREQUENTE entre as faturas conhecidas (fechamento ou
 * vencimento, conforme `campo`).
 *
 * PROBLEMA REAL que isto corrige: `dia_fechamento`/`dia_vencimento` vinham de
 * UMA fatura só — a mais recente (aberta, ou a última publicada quando não há
 * aberta). O Mercado Pago NUNCA publica fatura em aberto (documentado no
 * CLAUDE.md — "List Bills para no mês passado, já pago"), então cartão MP
 * sempre caía no caminho frágil: se aquela ÚNICA fatura fechou num dia
 * deslocado (fim de semana, feriado, atraso do banco), o app inteiro herdava
 * a anomalia como se fosse a regra — e o dia podia MUDAR de sync pra sync,
 * conforme qual fatura calhasse de ser "a mais recente" na hora.
 *
 * Medido numa conta real: o app do Mercado Pago mostra fechamento dia 8; o
 * painel mostrou 12 (puxado de uma única fatura) e, num sync anterior com
 * outro dia isolado, o ciclo ficou curto demais e sumiu uma transação real
 * (05/08) da tela de detalhes do cartão.
 *
 * A moda (dia que mais se repete) filtra o desvio pontual. Empate desempata
 * pela ocorrência mais recente — `bills` vem em ordem DESC de vencimento
 * (doc da Polp), então a primeira ocorrência de um dia já é a mais nova.
 */
/**
 * ⚠️ A moda considera só as faturas RECENTES (`JANELA_MODA`), não a história
 * toda. Quando o banco MUDA o dia de fechamento/vencimento — e o Mercado Pago
 * muda —, a moda de 12 faturas antigas continua vencendo a realidade por meses,
 * e o painel fica preso na data velha (caso real: painel 12/17, app 8/14).
 *
 * A janela é de 6 e não de 2 de propósito: com poucas faturas, UMA anomalia
 * (fechamento adiado por feriado) empata com a regra e o desempate por
 * recência elegeria justamente a anomalia — que é o bug que a moda veio
 * corrigir. Com 6, a anomalia perde; com uma mudança real, ela vira maioria em
 * ~3 ciclos. Se não houver faturas recentes com o campo, cai pra lista toda.
 */
const JANELA_MODA = 6;

function recentes(bills, campo) {
  // Ordena SEMPRE (não confia na ordem que a API mandou): o desempate por
  // recência depende de o índice 0 ser mesmo a fatura mais nova.
  return (Array.isArray(bills) ? bills : [])
    .filter((b) => b && b[campo] && b.due_date)
    .sort((a, b) => String(b.due_date).localeCompare(String(a.due_date)))
    .slice(0, JANELA_MODA);
}

function diaMaisFrequente(bills, campo) {
  const janela = recentes(bills, campo);
  const arr = janela.length ? janela : (Array.isArray(bills) ? bills : []);
  const cont = new Map(); // dia → { n, pos: índice da 1ª ocorrência }
  arr.forEach((b, i) => {
    const d = diaDoMes(b && b[campo]);
    if (d == null) return;
    if (!cont.has(d)) cont.set(d, { n: 0, pos: i });
    cont.get(d).n += 1;
  });
  if (!cont.size) return null;
  let melhor = null;
  for (const [d, { n, pos }] of cont) {
    if (!melhor || n > melhor.n || (n === melhor.n && pos < melhor.pos)) melhor = { d, n, pos };
  }
  return melhor.d;
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
 *
 * ⚠️ ATÉ AGO/2026 ESTA REGRA NÃO FECHAVA no trilho Celcoin, e o CLAUDE.md
 * registrava isso como limitação: faltava um número confiável pras "parcelas a
 * vencer". Transação com data futura vinha ZERO (a Celcoin manda toda parcela
 * com a data da COMPRA) e o endpoint `parcelamentos` vinha duplicado. Sem
 * subtraendo, a fatura tinha de sair da soma das transações — que erra a menos.
 *
 * O `unbilled_amount` (breaking change de 24/08/2026) É esse subtraendo: por
 * definição da doc, "transações com `bill_id` null", ou seja, o que ocupa
 * limite e ainda NÃO está em fatura nenhuma. Medido no cartão da cliente:
 *
 *     used_amount 3.155,80 − unbilled_amount 1.381,16 = 1.774,64
 *
 * que é exatamente, no centavo, a fatura que o app do Nubank mostrava.
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
  // A soma é ASSINADA (services/valorFatura.js): compra soma, estorno/cashback
  // ABATE, pagamento de fatura é neutro. Antes só entrava `ehGasto` e todo
  // crédito era descartado — a fatura da Sora ficava maior que a do banco.
  const naFatura = (p) => valorNaFatura({
    tipo: p.norm.ehGasto ? 'Gasto' : 'Recebimento',
    valor: p.norm.valor,
    categoria: p.norm.categoria,
    transferencia: p.norm.transferencia,
  });

  const billId = n.faturaAberta && n.faturaAberta.billId;
  if (billId && pares.some((p) => String(p.cru.bill_id || '') === billId)) {
    n.fonteFatura = 'bill_id';
    return Math.max(0, cent(pares
      .filter((p) => String(p.cru.bill_id || '') === billId)
      .reduce((s, p) => s + naFatura(p), 0)));
  }
  n.fonteFatura = 'ciclo';

  // 2. Ciclo real de fechamento (precisa da data de fechamento do banco).
  const cartao = { dia_fechamento: n.extras.dia_fechamento, dia_vencimento: n.extras.dia_vencimento };
  if (!cartao.dia_fechamento) return null;
  const ciclo = cicloPorCompetencia(cartao, competenciaAtual(cartao, hoje));
  n.cicloLabel = ciclo.label;
  return Math.max(0, cent(pares
    .filter((p) => ymd(p.norm.data) >= ciclo.ini && ymd(p.norm.data) < ciclo.fimExcl)
    .reduce((s, p) => s + naFatura(p), 0)));
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
  // ⚠️ `usoConhecido` é a régua da trava anti-sublimite (ver limitePorModalidade):
  // um teto menor do que a fatura do próprio cartão é impossível e não pode ser
  // adotado. Por isso o limite precisa das `bills`, não só de `card.limits`.
  const { limite, usado, disponivel, respondeu: limiteRespondeu } =
    limiteTotalDoCartao(card.limits, usoConhecido(card, bills));
  const aberta = escolherFaturaAberta(bills, hoje);
  // O VALOR só sai de uma fatura de fato aberta. A DATA (dia_fechamento/
  // dia_vencimento) usa a MODA entre as faturas conhecidas (diaMaisFrequente),
  // não uma fatura só — ver o porquê no comentário da função. `paraDatas`
  // segue existindo como fallback quando não há bills suficientes pra moda.
  const paraDatas = aberta || ultimaFaturaPublicada(bills);
  const diaFechamentoRecorrente = diaMaisFrequente(bills, 'bill_closing_date');
  const diaVencimentoRecorrente = diaMaisFrequente(bills, 'due_date');

  // Últimos 4 dígitos: pega o 1º método de pagamento (titular).
  const pm = Array.isArray(ident.payment_methods) ? ident.payment_methods[0] : null;
  const ultimos4 = pm && pm.identification_number
    ? String(pm.identification_number).replace(/\D/g, '').slice(-4) || null
    : null;

  // A FATURA vem do banco: total − o que já foi pago nela.
  const totalFatura = aberta ? money(aberta.bill_total_amount) : null;
  const publicadaRestante = totalFatura == null ? null : Math.max(0, cent(totalFatura - pagoDaFatura(aberta)));

  // ⭐ FATURA SIMULADA (campo novo da Polp, ago/2026) TEM PRIORIDADE.
  //
  // É o valor da fatura EM ANDAMENTO, já líquido de pagamentos. Resolve de uma
  // vez os dois furos que sobravam no trilho Celcoin:
  //   · o emissor só publica `bill_total_amount` depois que a fatura FECHA, e
  //     o Mercado Pago nunca publica a aberta — a tela tinha de somar as
  //     transações do ciclo, que sai a menos quando há parcelamento;
  //   · fatura paga continuava aparecendo cheia, porque o MP não manda
  //     `payments[]` e não havia o que descontar.
  //
  // Procuro na fatura aberta E no cartão: sem fatura publicada (o caso do MP)
  // só o cartão pode trazer. Ausente = `null` e tudo segue como antes.
  //
  // ⚠️ O `unbilled_amount` NÃO É A FATURA — é o SUBTRAENDO dela.
  //
  // Foi o erro que custou dois dias: eu li o breaking change de 24/08/2026,
  // troquei `simulated_bill_total_amount` por `unbilled_amount` e exibi o campo
  // novo direto, como se fosse o valor da fatura. Deu R$ 1.381,16 onde o banco
  // mostrava R$ 1.774,64.
  //
  // A doc define o campo como "soma das transações com `bill_id` NULL" — ou
  // seja, o que ocupa limite e ainda NÃO entrou em fatura nenhuma. Isso é
  // justamente a "parcela a vencer" que a REGRA DE OURO manda descontar:
  //
  //     fatura = used_amount − unbilled_amount
  //     3.155,80 − 1.381,16 = 1.774,64   ← o número do app do Nubank, no centavo
  //
  // `usado` sai de `limiteTotalDoCartao` (é card-level: vem igual em todas as
  // linhas de limits[]); o `unbilled` é POR PLÁSTICO e por isso é somado.
  const unbilled = unbilledDoCartao(card);
  // ⚠️ `usadoDoCartao` lê `used_amount` DIRETO de limits[], sem depender de o
  // teto ter sido adotado. Usar o `usado` do `limiteTotalDoCartao` amarrava a
  // fatura a uma decisão de exibição e deixava o Mercado Pago sem fatura.
  const usadoReal = usadoDoCartao(card);
  const simulada = (unbilled != null && usadoReal != null)
    ? faturaPorLimite(usadoReal, unbilled)
    // Sem um dos dois não dá pra aplicar a regra de ouro. O campo legado fica
    // de reserva pra payload antigo em cache; ausente = null e nada muda.
    : (faturaSimulada(aberta) ?? faturaSimulada(card));
  const faturaRestante = simulada != null ? simulada : publicadaRestante;

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
      // nos obrigava a pedir o fechamento na mão. A MODA entre as faturas
      // conhecidas é o dia recorrente de verdade; cai pra `paraDatas` (fatura
      // única) só quando não há bills suficientes pra calcular moda nenhuma —
      // zerar isso quando a fatura aberta ainda não foi publicada quebraria o
      // ciclo da tela inteira.
      dia_fechamento: diaFechamentoRecorrente ?? (paraDatas ? diaDoMes(paraDatas.bill_closing_date) : null),
      dia_vencimento: diaVencimentoRecorrente ?? (paraDatas ? diaDoMes(paraDatas.due_date) : null),
      bandeira: BANDEIRA[(card.credit_card_network || ident.credit_card_network || '').toString().toUpperCase()] || null,
      ultimos4,
      pagamento_minimo: aberta ? money(aberta.bill_minimum_amount) : null,
      // Qual fatura está em aberto (migration 101). Só quando ela EXISTE de
      // verdade: apontar pra uma fatura fechada fazia a tela somar as compras
      // dela junto com as do ciclo novo (R$ 5.013,99 no lugar de R$ 3.423,57).
      of_bill_atual: aberta ? String(aberta.id) : null,
      of_limite_usado: usado,
      // ⚠️ Marca que o banco RESPONDEU sobre limites. Não é coluna: o
      // `upsertWallet` lê e remove antes de gravar. Serve pra distinguir
      // "não tem limite total" (grava null, limpando um limite errado — o
      // caso do "Limite Nupay" de R$ 300,45 virando teto do cartão) de
      // "limits ainda não sincronizou" (a doc avisa que vem null), onde
      // apagar o limite bom seria pior.
      _limiteRespondeu: limiteRespondeu,
    },
    // Quanto a fatura simulada disse (ou `null`). Vai pro relatório do sync e
    // pro diagnóstico — é como a gente confere se o campo novo bate com o app
    // do banco sem ter de ler o JSON cru inteiro.
    faturaSimulada: simulada,
    faturaAberta: aberta
      ? {
          billId: String(aberta.id),
          total: totalFatura,
          pago: pagoDaFatura(aberta),
          restante: faturaRestante,
          simulada,
          fechamento: ymd(aberta.bill_closing_date),
          vencimento: ymd(aberta.due_date),
          parcelada: !!aberta.is_instalment,
        }
      // Sem fatura publicada (o caso do Mercado Pago) o simulado ainda vale:
      // é o único número do banco disponível pro ciclo em andamento.
      : (simulada != null
        ? { billId: null, total: null, pago: 0, restante: simulada, simulada, estimada: false, fonte: 'simulada' }
        : null),
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
// Nomes que o banco manda como "descrição" mas não descrevem NADA — são o tipo
// da operação, não com quem ela foi feita. Medido numa conta real: 115 de 377
// transações tinham a descrição literal "Pix", e o cliente reclamou que não
// dava pra revisar categoria nenhuma ("não trazem para onde o pix foi feito").
const RE_DESC_GENERICA = /^\s*(?:pix|ted|doc|transfer[êe]ncia|transferencia|pagamento|dep[óo]sito|deposito|saque|d[ée]bito|debito|cr[ée]dito|credito|compra|boleto|tarifa|estorno|recebimento|envio)\s*$/i;

/** Só os dígitos, mascarado no meio: 12345678901 → •••.456.789-•• */
function documentoMascarado(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) return `•••.${d.slice(3, 6)}.${d.slice(6, 9)}-••`;      // CPF
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/••••-••`; // CNPJ
  return null;
}

/**
 * Descrição legível de uma transação de conta.
 *
 * ⚠️ A ORDEM É O BUG QUE ISTO CORRIGE. Antes era
 * `transaction_name || cp.alias || cp.name` — e como o banco manda
 * `transaction_name: "Pix"` em TODO pix, a contraparte NUNCA era usada, mesmo
 * quando existia (Netflix, iFood…). O nome genérico vencia o nome real.
 *
 * ⚠️ A doc avisa que `counterparty` só é enriquecida quando
 * `partie_cnpj_cpf` é **CNPJ**: pix pra pessoa física não tem nome, e nunca
 * vai ter. Pra esses, o melhor possível é o TIPO + o documento mascarado —
 * some o "Pix" solto e vira algo que dá pra reconhecer no extrato.
 */
function descricaoTx(tx) {
  const cp = tx.counterparty || {};
  const bruta = String(tx.transaction_name || '').trim();
  const generica = !bruta || RE_DESC_GENERICA.test(bruta);

  // Contraparte real vence — `alias` (nome fantasia, "Netflix") antes de
  // `name` (razão social, "NETFLIX ENTRETENIMENTO BRASIL LTDA.").
  const nome = String(cp.alias || cp.name || '').trim();
  if (nome) return generica && bruta ? `${bruta} · ${nome}` : nome;

  // Sem contraparte: a descrição do banco serve, desde que diga algo.
  if (!generica) return bruta;

  // Genérica e sem contraparte — monta o melhor identificador possível.
  const partes = [bruta || String(tx.type || '').replace(/_/g, ' ')].filter(Boolean);
  const extra = String(tx.type_additional_info || '').trim();
  if (extra && !RE_DESC_GENERICA.test(extra)) partes.push(extra);
  else {
    const doc = documentoMascarado(tx.partie_cnpj_cpf);
    if (doc) partes.push(doc);
  }
  return partes.join(' · ').slice(0, 200) || 'Transação';
}

function normalizeTxConta(tx) {
  if (!efetivada(tx)) return null;

  const valor = money(tx.transaction_amount);
  if (valor == null) return null;
  const ehGasto = (tx.credit_debit_type || '').toString().toUpperCase() === 'DEBITO';
  const descricao = descricaoTx(tx);

  // Transferência entre contas próprias / aporte não é consumo.
  const ref = tx.category_ref || '';

  // ⚠️ O `category_ref` NÃO pode ser a única prova de pagamento de fatura: o
  // Mercado Pago manda "Pagamento Cartão de crédito" SEM
  // LOAN_PAYMENTS_CREDIT_CARD_PAYMENT, e a linha caía como Gasto/Outros —
  // inflando o relatório e o gráfico por categoria em R$ 2.243,60 (caso real).
  // A fatura é paga uma vez e aparece nos DOIS lados; contar o pagamento como
  // gasto conta em dobro, porque cada compra dela já foi categorizada.
  // A detecção por descrição existia no trilho Pluggy e não tinha sido portada.
  const pagouFatura = ref === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    || ehPagamentoFaturaDescricao(descricao, ref);

  const ehTransferencia = pagouFatura
    || ref === 'TRANSFER_OUT_ACCOUNT_TRANSFER' || ref === 'TRANSFER_IN_ACCOUNT_TRANSFER';

  return {
    externalId: String(tx.id),
    ehGasto,
    valor: Math.abs(valor),
    descricao,
    categoria: ehTransferencia
      ? (pagouFatura ? CATEGORIA_FATURA : 'Transferências')
      : categoriaDe(descricao, ref, ehGasto),
    data: tx.transaction_date_time || tx.created_at,
    transferencia: ehTransferencia,
    card: null,
  };
}

// ── Parcelas do cartão: redistribuir pelos meses ────────────────────────────
//
// PROBLEMA (medido na conta de um cliente, ago/2026): a Celcoin manda as N
// parcelas de uma compra como N transações separadas, TODAS carimbadas com a
// data da COMPRA — não com a data em que cada parcela é cobrada. Uma compra de
// 03/08 em 12x virou 12 gastos de R$29,90 no dia 03/08. Medido nessa conta:
// 16 compras parceladas, 47 linhas, R$ 2.055,67 inflados no histórico e
// R$ 380,40 só no ciclo aberto.
//
// A defesa que existia era o `bill_id` (a fatura que o emissor vinculou à
// linha), mas ele quase nunca vem: 80 de 577 transações (14%) — e ZERO nas
// parcelas da fatura ainda não publicada, que é exatamente onde importa.
//
// Solução: ler o marcador "N/M" que o emissor põe na descrição e datar cada
// parcela em compra + (N−1) meses. A parcela do mês cai na fatura certa e as
// futuras ficam agendadas, aparecendo como previstas até a cobrança chegar.

/** Tira o marcador "3/12" do fim da descrição. */
function baseSemMarcador(descricao) {
  return String(descricao || '').trim().replace(/\s+\d{1,2}\/\d{1,2}$/, '').trim();
}

/** "Amazon Br Digital 3/12" → { base: 'Amazon Br Digital', n: 3, total: 12 } */
function parcelaDaDescricao(descricao) {
  const m = String(descricao || '').trim().match(/^(.*?)\s+(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[2]);
  const total = Number(m[3]);
  // total ≥ 2: "1/1" não é parcelamento. n ≤ total: descarta lixo tipo "13/12".
  if (!(n >= 1 && total >= 2 && n <= total)) return null;
  const base = m[1].trim();
  if (!base) return null;
  return { base, n, total };
}

/**
 * Número e total da parcela de uma transação de cartão.
 *
 * PREFERE os campos ESTRUTURADOS que a Celcoin manda (`charge_identificator` =
 * parcela atual, `charge_number` = total — docs/CELCOIN-API.md §5.2) e só cai
 * na descrição quando eles não vêm. Parse de texto é o último recurso: o
 * marcador depende de o emissor escrever "3/12" no nome, o que nem todo banco
 * faz e nenhum garante.
 */
function parcelaDaTx(tx, descricao) {
  const n = Number(tx && tx.charge_identificator);
  const total = Number(tx && tx.charge_number);
  if (Number.isInteger(n) && Number.isInteger(total) && total >= 2 && n >= 1 && n <= total) {
    const base = baseSemMarcador(descricao);
    if (base) return { base, n, total, fonte: 'campo' };
  }
  const p = parcelaDaDescricao(descricao);
  return p ? { ...p, fonte: 'descricao' } : null;
}

/**
 * `bill_post_date` — a data em que o EMISSOR lançou a compra na fatura.
 *
 * ⚠️ VALIDA DE VERDADE, e não é preciosismo: o Mercado Pago manda um
  * PLACEHOLDER nesse campo. Medido na primeira carga, 88 de 89 linhas de um
 * cartão real vieram com ano 0001 — e foram gravadas como `0001-01-01`, que
 * é pior que não ter nada: agrupar a fatura por essa data jogaria a linha
 * inteira pra fora de qualquer ciclo.
 *
 * Por isso o corte é por ANO PLAUSÍVEL, não por "parece uma data". Cartão de
 * crédito não tem lançamento antes de 2000, e o que vier fora disso é ruído
 * do emissor — devolve null e a linha volta a ser agrupada pela data da
 * compra, que é o comportamento de sempre.
 */
function dataDeLancamento(valor) {
  const d = String(valor || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const ano = Number(d.slice(0, 4));
  if (!(ano >= 2000 && ano <= 2100)) return null;
  return d;
}

/**
 * Data em que a parcela N é cobrada = compra + (N−1) meses.
 * Clampa o dia em 28 e ancora ao meio-dia UTC — MESMA regra do parcelamento
 * manual (handlers/parcelas.js), pra compra parcelada digitada e importada
 * caírem no mesmo dia. Sem o clamp, compra dia 31 pularia de mês em fevereiro;
 * sem o meio-dia, o fuso viraria o dia (o painel usa America/Sao_Paulo).
 */
function dataDaParcela(dataCompra, n) {
  const d = new Date(dataCompra);
  if (Number.isNaN(d.getTime())) return null;
  // ⚠️ Dia no fuso de SÃO PAULO, nunca em UTC (regra do CLAUDE.md). Medido na
  // conta real: a compra foi 03/08 às 21h39 no Brasil, que em UTC já é 04/08 —
  // com getUTCDate() as 12 parcelas cairiam todas um dia pra frente.
  const [Y, M, D] = d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-').map(Number);
  return new Date(Date.UTC(Y, (M - 1) + (n - 1), Math.min(D, 28), 12)).toISOString();
}

/**
 * Identificador do parcelamento. Tem de ser DETERMINÍSTICO: as parcelas podem
 * ser importadas em syncs diferentes e precisam cair no mesmo grupo (é ele que
 * faz o "excluir todas", a badge "3/12" e a exclusão da detecção de recorrência
 * funcionarem). Por isso é hash, não aleatório como no parcelamento manual.
 *
 * ⚠️ O valor entra ARREDONDADO AO REAL de propósito: o emissor manda a mesma
 * compra com centavos diferentes entre as parcelas (medido: 52,19 · 52,20 ·
 * 52,23), e usar centavo exato quebraria uma compra em vários grupos. O preço
 * disso é que duas compras distintas na mesma loja, no mesmo dia, com o mesmo
 * número de parcelas e valor próximo caem no mesmo grupo — é o mesmo limite
 * que a Polp relatou no algoritmo deles, e não há identificador de compra no
 * Open Finance pra resolver isso direito.
 *
 * Não entra identificador de cartão na chave: a transação de cartão da Celcoin
 * não publica um (docs §5.2) e o grupo já é sempre consultado dentro de um
 * `grupo_id`. Assim o hash também fica reproduzível fora do sync (backfill).
 */
function grupoDaParcela(base, total, valor, dataCompra) {
  const chave = [
    String(base || '').toUpperCase(),
    total,
    Math.round(Number(valor) || 0),
    String(dataCompra || '').slice(0, 10),
  ].join('|');
  return 'OF' + crypto.createHash('sha1').update(chave).digest('hex').slice(0, 10).toUpperCase();
}

/** Transação de CARTÃO. Devolve `null` quando não deve ser importada. */
function normalizeTxCartao(tx, hoje) {
  // Pré-autorização/agendamento não entra na fatura (ver NAO_EFETIVADA).
  if (!efetivada(tx)) return null;

  // ⚠️ brazilian_amount (BRL). `amount` é a moeda ORIGINAL (compra internacional).
  const valor = money(tx.brazilian_amount) ?? money(tx.amount);
  if (valor == null) return null;

  const tipoTx = (tx.transaction_type || '').toString().toUpperCase();
  const ehCredito = (tx.credit_debit_type || '').toString().toUpperCase() === 'CREDITO';
  const cp = tx.counterparty || {};
  const descricao = (tx.transaction_name || cp.alias || cp.name || '').toString();

  const dataCompra = tx.transaction_date_time || tx.bill_post_date;
  const jaEraFutura = !!(ymd(dataCompra) && ymd(dataCompra) > hoje);
  const p = parcelaDaTx(tx, descricao);

  // Redistribui a parcela pelo mês em que ela é cobrada. Só quando a data crua
  // NÃO é futura: se o emissor já datou a parcela lá na frente (é o que o
  // trilho Pluggy faz), deslocar de novo dobraria o salto.
  let data = dataCompra;
  let redistribuida = false;
  if (p && p.n > 1 && !jaEraFutura) {
    const d = dataDaParcela(dataCompra, p.n);
    if (d) { data = d; redistribuida = true; }
  }

  // Futura e NÃO redistribuída por nós → continua fora, como sempre foi.
  //
  // A diferença entre os dois casos é a JANELA DO SYNC (90 dias, filtrada por
  // transaction_date_time):
  //   · linha que o emissor JÁ datou no futuro (ex.: "HOTEIS.COM 12/12" em
  //     2027) segue sendo devolvida em todo sync — quando a data chegar, ela
  //     entra sozinha. Não precisa (nem deve) ser importada antes.
  //   · linha que redistribuímos carrega a data da COMPRA. Uma compra em 12x
  //     sai da janela de 90 dias em ~3 meses, então as parcelas 5 a 12 NUNCA
  //     seriam importadas se esperássemos a data delas chegar. Ou entra agora,
  //     ou se perde.
  if (!redistribuida && ymd(data) && ymd(data) > hoje) return null;

  // ⚠️ PAGAMENTO DE FATURA e CRÉDITO/ESTORNO são coisas DIFERENTES e não podem
  // sair com a mesma cara — era o que acontecia (tudo virava categoria
  // 'Fatura'), e por isso "Crédito de parcelamento de compra" aparecia como
  // pagamento de fatura e o estorno não abatia nada:
  //   · pagamento da fatura → NEUTRO na fatura (abate via `pagamentos_fatura`;
  //     somar aqui contaria em dobro);
  //   · estorno/cashback/crédito de parcelamento → ABATE a fatura (é consumo
  //     que voltou; devolve limite também).
  // Quem lê essa diferença é `services/valorFatura.js`, pela dupla
  // `transferencia = true` + categoria.
  // ⚠️ `ehPagamentoNoCartao` é EXCLUSIVO desta função (transações de CARTÃO).
  //
  // BUG REAL, e o mais caro que este arquivo já teve: o Nubank descreve o
  // pagamento da fatura como **"Pagamento recebido"** — sem a palavra "fatura"
  // nem "cartão". O `ehPagamentoFaturaDescricao` (compartilhado com as contas)
  // exige as duas palavras juntas, de propósito, então não casava. A linha caía
  // em `creditoAjuste` → categoria Reembolso → e ABATIA a fatura.
  //
  // Efeito medido na conta do relato: um pagamento de R$ 2.293,71 entrando como
  // abatimento derrubava a soma do ciclo pra −R$ 2.256,09. É exatamente o
  // sintoma que o cliente descreveu — a fatura do app MENOR que a do banco.
  //
  // Por que não pôr "pagamento recebido" no regex compartilhado: numa CONTA
  // bancária "Pagamento recebido" é uma receita de verdade (alguém te pagou), e
  // marcá-la como transferência a apagaria do dashboard. Aqui é seguro porque
  // um CRÉDITO num cartão de crédito com essa descrição só pode ser a quitação
  // da fatura — cartão não recebe salário.
  // ⚠️ CADA BANCO TEM A SUA FRASE, e nenhuma delas diz "fatura".
  // Medido na base (1.037 créditos em carteira de cartão): 12 pagamentos de
  // fatura entravam como estorno, R$ 35.516,30 abatendo fatura que já tinha
  // sido paga por fora. A prova de que são quitação e não crédito: o valor
  // BATE com o total de uma fatura publicada pelo banco —
  //   · "PAGAMENTO DEBITO AUTOMATICO" (Itaú) ....... 4x, R$ 30.384,92
  //   · "Obrigado pelo pagamento" (Visa Infinite) ... 3x, R$  2.188,71
  //   · "Pagamento com saldo" (Itaú Click) .......... 3x, R$    917,77
  //   · "PAGAMENTO ON LINE" (Gold) .................. 1x, R$  2.024,90
  //   · "Pagamento recebido" (Nubank) ............... o caso de origem
  //
  // ⚠️ E O QUE NÃO PODE ENTRAR: "PAGAMENTO CASHBACK TAG" (R$ 5,00 todo mês
  // num cartão da base) tem a palavra "pagamento" e NÃO é quitação — é
  // cashback, ou seja, consumo que voltou, e tem de seguir ABATENDO a fatura.
  // Por isso a lista é de FRASES INTEIRAS, não da palavra solta, e o cashback
  // é barrado explicitamente.
  const descNorm = String(descricao || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const ehPagamentoNoCartao = ehCredito
    && !/\bcashback\b/.test(descNorm)
    && (/\bpagamento\s+recebido\b/.test(descNorm)
      || /\bpagamento\b[\s\S]*\bdebito\s+automatico\b/.test(descNorm)
      || /\bobrigado\s+pelo\s+pagamento\b/.test(descNorm)
      || /\bpagamento\s+com\s+saldo\b/.test(descNorm)
      || /\bpagamento\s+on\s*-?\s*line\b/.test(descNorm));

  const pagouFatura = tipoTx === 'PAGAMENTO_FATURA'
    || tx.category_ref === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    || ehPagamentoNoCartao
    || ehPagamentoFaturaDescricao(descricao, tx.category_ref);
  // Exige `ehCredito`: um "ESTORNO" que venha como DÉBITO é cobrança de
  // verdade (estorno de um crédito anterior) e tem de seguir como Gasto.
  const creditoAjuste = ehCredito && !pagouFatura;

  // Os DOIS ficam fora de receita/gasto do dashboard (resumoTransacoes trata
  // `transferencia` assim) — estorno não pode virar "receita comum".
  const ehTransferencia = pagouFatura || creditoAjuste;

  return {
    externalId: String(tx.id),
    ehGasto: !ehCredito,
    valor: Math.abs(valor),
    descricao,
    categoria: pagouFatura ? CATEGORIA_FATURA
      : creditoAjuste ? CATEGORIA_ESTORNO
        : categoriaDe(descricao, tx.category_ref, !ehCredito),
    data,
    transferencia: ehTransferencia,
    // Parcela que ainda não foi cobrada nasce NÃO paga (o resto do cartão nasce
    // pago — ver CLAUDE.md). É o que faz ela contar como prevista, igual à
    // compra parcelada digitada à mão.
    pago: !(ymd(data) && ymd(data) > hoje),
    // Quem consome: a reconciliação do histórico (ver reconciliarParcelas).
    redistribuida,
    parcelaNum: p ? p.n : null,
    parcelaTotal: p ? p.total : null,
    parcelaGrupo: p && !ehTransferencia
      ? grupoDaParcela(p.base, p.total, Math.abs(valor), dataCompra)
      : null,
    // Cartão virtual/adicional (a Sora já mostra isso em of_card).
    card: tx.identification_number ? String(tx.identification_number).slice(-4) : null,
    // Fatura a que o EMISSOR vinculou esta linha (migration 101). Continua
    // sendo o dado mais confiável quando vem — mas vem em só ~14% das linhas,
    // por isso a redistribuição acima não pode depender dele.
    billId: tx.bill_id ? String(tx.bill_id) : null,
    // ⚠️ A DATA EM QUE O BANCO LANÇOU a compra na fatura (migration 130). Não
    // é a data da compra: uma compra do dia 04 processada dia 09 tem
    // `bill_post_date` = 09, e é POR ELA que o emissor decide a fatura.
    // Guardada à parte de propósito — `data` continua sendo a da COMPRA, que é
    // a que o usuário reconhece e que o resto do painel usa.
    billPostDate: dataDeLancamento(tx.bill_post_date),
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
/**
 * Campos do produto: RAIZ primeiro, `product` aninhado como último recurso.
 *
 * ⚠️ A doc da Celcoin (versão atual) é explícita: "Campos de `product` passam a
 * existir na raiz. O objeto `product` aninhado é LEGADO — preferir os campos da
 * raiz" e "`product` (legado) pode retornar **null** se o Product Identification
 * ainda não foi sincronizado".
 *
 * Lendo só o legado (como era), todo investimento cujo produto ainda não
 * sincronizou perdia ticker, nome, ISIN e datas de uma vez — virava
 * "Investimento" genérico, e em renda variável caía como "Ações" mesmo sendo
 * FII, porque a classificação depende do ticker.
 */
const CAMPOS_PRODUTO = [
  'product_name', 'name', 'ticker', 'isin_code', 'due_date', 'purchase_date',
  'remuneration', 'anbima_category', 'issuer_institution_cnpj_number',
];
function produtoDe(inv) {
  const legado = inv.product || {};
  const p = {};
  for (const k of CAMPOS_PRODUTO) p[k] = inv[k] != null ? inv[k] : legado[k];
  return p;
}

/**
 * ⚠️ LIMITE CONHECIDO em renda variável: a Celcoin **não manda tipo de ativo** —
 * o recurso só tem `ticker` e `isin_code` (conferido na doc de
 * variable-incomes/show). Então FII × ETF × ação sai de heurística de ticker:
 * final 11 → FII. Isso classifica **ETF como FII** (BOVA11, IVVB11) e direito
 * de subscrição (final 12/13) como ação. Sem campo de tipo na origem não dá pra
 * resolver direito — e chutar uma lista de ETFs conhecidos envelhece mal.
 */
function tipoInvestimento(inv) {
  const fam = inv.__familia;
  if (fam === 'treasure_title') return 'Tesouro Direto';
  if (fam === 'bank_fixed_income') return 'CDB';        // CDB/RDB/LCI/LCA
  if (fam === 'credit_fixed_income') return 'Renda Fixa'; // Debêntures/CRI/CRA
  if (fam === 'fund') return 'Fundos';
  if (fam === 'variable_income') {
    const t = produtoDe(inv).ticker || '';
    return /11$/.test(String(t)) ? 'FIIs' : 'Ações';    // FII normalmente termina em 11
  }
  return 'Renda Fixa';
}

function normalizeInvestimento(inv) {
  const p = produtoDe(inv);
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

  // Campos em que `null` é RESPOSTA, não ausência de dado — precisam ser
  // GRAVADOS como null em vez de ignorados.
  //
  // ⚠️ `of_bill_atual` é o caso caro. O filtro geral de nulos existe pra não
  // zerar o que o banco não mandou (ex.: dia_fechamento), mas nele null quer
  // dizer "não há fatura publicada em aberto" — e como nunca era gravado, o
  // cartão ficava apontando pra uma fatura VELHA pra sempre. O painel então
  // filtrava as transações por aquela fatura morta e escondia tudo que veio
  // depois do fechamento dela (caso real: fatura fechada em 08/08 mostrando
  // lançamentos só até 31/07).
  // `limite`/`of_limite_usado` entram na lista SÓ quando o banco respondeu
  // sobre limites (`_limiteRespondeu`) — aí `null` quer dizer "este cartão não
  // tem LIMITE_CREDITO_TOTAL", e gravar null LIMPA um limite errado guardado
  // antes (o "Limite Nupay" de R$ 300,45 que virava teto do cartão). Quando o
  // banco não respondeu, `null` é ausência de dado e não pode apagar o que já
  // está lá — a doc avisa que `limits` vem null enquanto não sincroniza.
  const limiteRespondeu = n.extras && n.extras._limiteRespondeu === true;
  const NULO_VALIDO = new Set(
    limiteRespondeu ? ['of_bill_atual', 'limite', 'of_limite_usado'] : ['of_bill_atual']);
  const extras = Object.fromEntries(
    Object.entries(n.extras || {})
      .filter(([k]) => k !== '_limiteRespondeu')        // flag interna, não é coluna
      .filter(([k, v]) => v != null || NULO_VALIDO.has(k)));
  // `extras` só traz o que o normalize mandou; garante o null explícito.
  if (n.extras && 'of_bill_atual' in n.extras) extras.of_bill_atual = n.extras.of_bill_atual ?? null;
  if (limiteRespondeu) {
    extras.limite = n.extras.limite ?? null;
    extras.of_limite_usado = n.extras.of_limite_usado ?? null;
  }

  const patchSaldo = saldo == null ? {} : { saldo };

  // ⚠️ Se UMA coluna dos extras não existir (migration nova ainda não rodada), o
  // update inteiro falha — e levaria o SALDO junto, zerando a fatura na tela.
  // Por isso: tenta com tudo e, no erro, repete só com o essencial.
  const atualizar = async (id) => {
    const { error } = await supabase.from('wallets')
      .update({ tipo: n.tipo, ...patchSaldo, ...extras }).eq('id', id);
    if (error) await supabase.from('wallets').update({ tipo: n.tipo, ...patchSaldo }).eq('id', id);
  };

  // ⚠️ `select('*')` de propósito: `datas_manuais` é da migration 114 e, se ela
  // ainda não rodou, um select POR NOME de coluna falha inteiro — `ja` viria
  // null e o sync criaria uma carteira NOVA, duplicando o cartão do usuário.
  // Com '*', a coluna ausente simplesmente não vem e o `if` abaixo é falso.
  const { data: ja } = await supabase.from('wallets')
    .select('*').eq('grupo_id', grupoId).eq('of_conta_id', n.externalId).maybeSingle();
  if (ja) {
    // ⚠️ Data corrigida À MÃO tem a palavra final (migration 114). O banco às
    // vezes está errado: o Mercado Pago publica "fecha 12 / vence 17" em TODAS
    // as faturas enquanto o app dele mostra 8 / 14 — ele mudou o ciclo e ainda
    // não publicou fatura nenhuma no ciclo novo, então a API não tem como saber.
    // Sem esta trava, a correção do usuário voltava atrás no sync seguinte.
    if (ja.datas_manuais) {
      delete extras.dia_fechamento;
      delete extras.dia_vencimento;
    }

    // ⚠️ NUNCA APAGA UM LIMITE QUE JÁ EXISTE. O sync escrevia `limite = null`
    // sempre que o banco respondia sobre limites SEM publicar um
    // `LIMITE_CREDITO_TOTAL` — e é exatamente o caso do Mercado Pago. Resultado:
    // o usuário editava o limite à mão, salvava, e o sync seguinte zerava. Como
    // ele roda por webhook, a edição sumia em minutos e parecia que "não salva".
    // Medido em 25/08/2026: 15 dos 29 cartões de OF estavam com limite nulo, 3
    // deles Mercado Pago.
    //
    // O null-write nasceu pra LIMPAR um teto falso (o "Limite Nupay" de R$
    // 300,45 que virou limite de um cartão com fatura de R$ 2.293,71). Essa
    // proteção não depende mais dele: hoje a trava anti-sublimite recusa o
    // candidato na origem (ver `limitePorModalidade`), então o teto falso nem
    // chega a ser gravado.
    //
    // Preço consciente: um limite errado gravado ANTES daquela trava não se
    // limpa sozinho. É reversível pelo usuário em dois toques; perder a edição
    // dele a cada sync não era.
    if (extras.limite == null && ja.limite != null) delete extras.limite;

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

/**
 * BACKFILL da data de lançamento (migration 130).
 *
 * O sync não reescreve linha existente, então tudo que já foi importado ficou
 * sem `of_bill_post_date` — e é justamente o histórico que a gente precisa pra
 * medir e pra agrupar a fatura direito.
 *
 * ⚠️ É ADITIVO E SÓ ISSO: preenche onde está NULL e nunca sobrescreve. Não
 * toca em data, categoria, valor nem em nada que o usuário possa ter mexido.
 * Some sozinho quando o histórico estiver completo (não acha mais nulos).
 *
 * Tolerante: sem a migration, não faz nada e o sync segue igual.
 */
async function backfillBillPostDate(grupoId, normalizadas) {
  const linhas = (normalizadas || []).filter((t) => t && t.externalId && t.billPostDate);
  if (!linhas.length) return 0;
  let n = 0;
  for (const t of linhas) {
    try {
      const { data: atual, error } = await supabase.from('transacoes')
        .select('id, of_bill_post_date')
        .eq('grupo_id', grupoId).eq('of_tx_id', t.externalId).maybeSingle();
      if (error) return n;                    // migration 130 pendente: para
      if (!atual || atual.of_bill_post_date) continue;   // já tem, não mexe
      const { error: e2 } = await supabase.from('transacoes')
        .update({ of_bill_post_date: t.billPostDate }).eq('id', atual.id);
      if (!e2) n++;
    } catch { return n; }
  }
  return n;
}

/**
 * RECONCILIA a data das parcelas JÁ IMPORTADAS.
 *
 * ⚠️ ESTE É O CONSERTO DA FATURA DIVERGENTE, e a causa é banal: o cálculo
 * sempre esteve certo, o histórico é que não era reescrito.
 *
 * A API manda `charge_identificator`/`charge_number` (doc de
 * /credit-cards/{id}/transactions: "número da parcela atual" / "quantidade
 * total"), `parcelaDaTx` lê, e `normalizeTxCartao` já desloca a parcela N pra
 * compra + (N−1) meses. Medido no cartão do relato, com o payload VIVO:
 *
 *   CHINOCA 1/3   data crua 2026-06-20 → calculada 2026-06-20
 *   CHINOCA 2/3   data crua 2026-06-20 → calculada 2026-07-20
 *   CHINOCA 3/3   data crua 2026-06-20 → calculada 2026-08-20
 *   PayU    2/2   data crua 2026-07-14 → calculada 2026-08-13
 *   PROSED  2/2   data crua 2026-08-03 → calculada 2026-09-03
 *
 * Tudo certo. Só que essas linhas já existiam no banco com a data da COMPRA
 * (importadas antes desse cálculo existir), e `inserirTransacoes` dedupa por
 * `of_tx_id` — então a data certa nunca chegava à tabela. Resultado: a fatura
 * da compra inflada e as seguintes vazias, para sempre. Fatura em aberto
 * R$ 1.319,66 na Sora contra R$ 1.596,17 no app; a diferença eram exatamente
 * as parcelas presas no passado.
 *
 * ⚠️ É EXCEÇÃO ESTREITA à regra de "o sync nunca reescreve linha existente".
 * A regra existe pra não apagar a CATEGORIA que o usuário corrigiu à mão —
 * aqui só `data`, `pago` e os campos de parcela são tocados. Categoria, valor
 * e observação ficam intactos. Mesmo espírito da melhora de descrição abaixo.
 *
 * Tolerante em tudo: falhar aqui não pode derrubar o sync.
 */
async function reconciliarParcelas(grupoId, normalizadas) {
  let corrigidas = 0;
  // Só parcela que o sync DESLOCOU (2ª em diante). A 1ª fica na data da compra
  // e não tem o que reconciliar.
  const linhas = (normalizadas || []).filter((t) => t && t.redistribuida);
  for (const t of linhas) {
    if (!t.externalId || !t.data) continue;
    try {
      const { data: atual } = await supabase.from('transacoes')
        .select('id, data').eq('grupo_id', grupoId).eq('of_tx_id', t.externalId).maybeSingle();
      if (!atual) continue;                       // ainda não importada: entra já certa
      if (ymd(atual.data) === ymd(t.data)) continue;   // já está na data certa
      const { error } = await supabase.from('transacoes').update({
        data: t.data,
        pago: t.pago,
        parcela_num: t.parcelaNum || null,
        parcela_total: t.parcelaTotal || null,
        parcela_grupo: t.parcelaGrupo || null,
      }).eq('id', atual.id);
      if (!error) corrigidas++;
    } catch { /* ignora */ }
  }
  return corrigidas;
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

  // ⚠️ O que o usuário APAGOU não pode voltar (migration 113). O dedup acima
  // olha a tabela `transacoes`: linha apagada não é encontrada e o sync
  // reimportaria como nova — excluir transação do Open Finance não adiantava
  // nada. Tolerante: sem a migration, segue o comportamento antigo.
  try {
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await supabase.from('of_tx_ignoradas')
        .select('of_tx_id').eq('grupo_id', grupoId).in('of_tx_id', ids.slice(i, i + 300));
      (data || []).forEach((d) => existentes.add(d.of_tx_id));
    }
  } catch { /* migration 113 pendente */ }

  // ── Melhora a descrição das linhas JÁ importadas ────────────────────────
  //
  // O sync nunca reescreve linha existente (de propósito — senão apagaria a
  // categoria que o usuário corrigiu à mão). Mas a descrição genérica é um
  // caso à parte: quem já importou 115 pix chamados só "Pix" ficaria com eles
  // pra sempre, mesmo depois do fix — e foi exatamente essa a queixa.
  //
  // ⚠️ ESTREITO DE PROPÓSITO: só troca quando a descrição GUARDADA é genérica
  // ("Pix", "TED"…) E a nova diz mais. Nunca toca em descrição que o usuário
  // escreveu ou corrigiu — pra isso ela teria de ser exatamente "Pix", o que
  // ninguém digita. Tolerante: falhar aqui não pode derrubar a importação.
  try {
    const melhoraveis = validas.filter((t) => existentes.has(t.externalId)
      && t.descricao && !RE_DESC_GENERICA.test(t.descricao));
    for (const t of melhoraveis) {
      const { data: atual } = await supabase.from('transacoes')
        .select('id, observacao').eq('of_tx_id', t.externalId).eq('grupo_id', grupoId).maybeSingle();
      if (!atual || !RE_DESC_GENERICA.test(String(atual.observacao || ''))) continue;
      await supabase.from('transacoes')
        .update({ observacao: t.descricao.slice(0, 200) }).eq('id', atual.id);
    }
  } catch { /* melhoria cosmética: nunca derruba o sync */ }

  let novas = validas.filter((t) => !existentes.has(t.externalId)).map((t) => ({
    id_curto: idCurto(), grupo_id: grupoId, criado_por: userId || null,
    tipo: t.ehGasto ? 'Gasto' : 'Recebimento',
    categoria: t.categoria || 'Outros',
    valor: t.valor,
    observacao: (t.descricao || '').slice(0, 200),
    carteira_nome: walletNome,
    // Gasto em cartão nasce pago (ver CLAUDE.md). A exceção é a parcela ainda
    // não cobrada, que o normalize marca como não paga pra contar como prevista.
    pago: t.pago !== undefined ? t.pago : true,
    transferencia: !!t.transferencia,
    data: t.data,
    of_tx_id: t.externalId,
    of_card: t.card || null,
    of_bill_id: t.billId || null,
    of_bill_post_date: t.billPostDate || null,
    parcela_num: t.parcelaNum ?? null,
    parcela_total: t.parcelaTotal ?? null,
    parcela_grupo: t.parcelaGrupo ?? null,
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

  // Colunas que podem não existir no ambiente (of_bill_id = migration 101,
  // parcela_* = migration 071). Se faltarem, reinsere sem elas em vez de
  // derrubar a sincronização inteira — são extras, não o dado principal.
  // ⚠️ Colunas de migration: se alguma não existir, o insert INTEIRO falha e a
  // importação perde o lote. Aqui o erro é reconhecido e o lote repetido sem
  // elas. `of_bill_post_date` é a 130.
  const COLUNAS_OPCIONAIS = /of_bill_id|of_bill_post_date|parcela_num|parcela_total|parcela_grupo/i;
  const semOpcionais = (r) => {
    const { of_bill_id, of_bill_post_date, parcela_num, parcela_total, parcela_grupo, ...resto } = r;
    return resto;
  };

  let { error } = await supabase.from('transacoes').insert(novas);
  if (error && COLUNAS_OPCIONAIS.test(error.message || '')) {
    const limpas = novas.map(semOpcionais);
    ({ error } = await supabase.from('transacoes').insert(limpas));
    if (!error) return limpas.length;
  }
  if (error) {
    // Fallback 1 a 1 — a unique de of_tx_id ignora corrida entre syncs.
    let ok = 0;
    for (const row of novas) {
      let { error: e } = await supabase.from('transacoes').insert(row);
      if (e && COLUNAS_OPCIONAIS.test(e.message || '')) {
        ({ error: e } = await supabase.from('transacoes').insert(semOpcionais(row)));
      }
      if (!e) ok++;
    }
    return ok;
  }
  return novas.length;
}

/** Cria/atualiza a dívida (empréstimo/financiamento) vinda do OF. */
/** Texto comparável: sem acento, minúsculo, só letras/números. */
function normTexto(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A dívida MANUAL `m` é o mesmo contrato que a dívida `d` vinda do Open Finance?
 *
 * Os três critérios juntos (mesmo nº de parcelas + mesma parcela + mesmo banco)
 * são propositalmente estreitos: é muito mais barato deixar uma duplicata
 * passar do que FUNDIR duas dívidas diferentes do usuário. Note que o VALOR
 * TOTAL fica de fora de propósito — é justamente onde os dois divergem (o
 * usuário costuma anotar o saldo devedor; o banco manda o valor contratado).
 */
function mesmaDividaManual(m, d) {
  if (!m || !d || m.of_id) return false;
  if (m.status === 'quitada') return false;             // quitada não é a dívida em curso

  const parcelasM = Number(m.parcelas_total);
  const parcelasD = Number(d.parcelas_total);
  if (!parcelasM || !parcelasD || parcelasM !== parcelasD) return false;

  const vpM = Number(m.valor_parcela);
  const vpD = Number(d.valor_parcela);
  if (!vpM || !vpD || Math.abs(vpM - vpD) > 1) return false;  // centavos de diferença passam

  // O banco tem de aparecer no credor OU no título que o usuário digitou.
  const banco = normTexto(d.credor);
  if (!banco) return false;
  return `${normTexto(m.credor)} ${normTexto(m.titulo)}`.includes(banco);
}

/** Procura no banco a dívida manual gêmea de `d`. Tolerante à migration 100. */
async function gemeaManual(grupoId, d) {
  try {
    const { data, error } = await supabase.from('dividas')
      .select('id, titulo, credor, valor_parcela, parcelas_total, status, of_id')
      .eq('grupo_id', grupoId).is('of_id', null);
    if (error) return null;                              // 100 ainda não rodou
    return (data || []).find((m) => mesmaDividaManual(m, d)) || null;
  } catch { return null; }
}

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

  // O usuário já tinha cadastrado essa dívida À MÃO? Então ADOTA a linha dele
  // em vez de criar uma segunda. Sem isto, quem lançou os empréstimos
  // manualmente e depois conectou o banco fica com a dívida DUPLICADA — e a
  // cópia manual normalmente traz o SALDO DEVEDOR no lugar do valor
  // contratado, o que infla o total devido do painel (caso real: um empréstimo
  // Nubank de 36×629,51 lançado como "R$ 18.255,88" convivendo com o
  // "Credito Pessoal · R$ 8.000" que o Open Finance trouxe do mesmo contrato).
  //
  // Adotar preserva o id — ou seja, o histórico de `divida_pagamentos`, a foto
  // e o lembrete que o usuário já tinha continuam valendo.
  const gemea = await gemeaManual(grupoId, d);
  if (gemea) {
    await supabase.from('dividas')
      .update({ ...base, of_id: d.externalId, of_provider: PROVIDER, origem: 'of' })
      .eq('id', gemea.id);
    return 'adotada';
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

/**
 * Cria/atualiza a caixinha e devolve o external id (pra reconciliação).
 *
 * ⚠️ Tolerante à migration 120 ainda não rodada: as colunas de remuneração são
 * novas, e a lição da casa é que coluna nova em caminho crítico derruba a
 * feature inteira antes do SQL rodar. Se o insert completo falhar, regrava só
 * com o que a 069 já tinha — a caixinha aparece no painel sem o "rende X% do
 * CDI", em vez de não aparecer.
 */
async function upsertCaixinha(grupoId, userId, conexaoId, n) {
  const base = {
    conexao_id: conexaoId, user_id: userId, grupo_id: grupoId,
    provider: PROVIDER, external_id: n.externalId,
    nome: n.nome, tipo: n.tipo, saldo: n.saldo, moeda: n.moeda,
    atualizado_em: n.atualizado_em || new Date().toISOString(),
  };
  const completo = {
    ...base,
    of_conta_id: n.of_conta_id,
    indexador: n.indexador, indexador_pct: n.indexador_pct, taxa_pre: n.taxa_pre,
    rate_type: n.rate_type, periodicidade: n.periodicidade, calculo: n.calculo,
  };

  const { error } = await supabase.from('of_caixinhas')
    .upsert(completo, { onConflict: 'provider,external_id' });
  if (!error) return n.externalId;

  const { error: e2 } = await supabase.from('of_caixinhas')
    .upsert(base, { onConflict: 'provider,external_id' });
  if (e2) throw new Error(`caixinha: ${e2.message}`);
  return n.externalId;
}

/**
 * Apaga as caixinhas da conta que o banco não mandou mais (o usuário fechou a
 * caixinha). É PROJEÇÃO do estado do banco, igual `of_faturas` — não há dado do
 * usuário aqui pra preservar.
 *
 * ⚠️ Só é chamado quando a leitura na Polp DEU CERTO. Reconciliar em cima de
 * uma falha de rede apagaria todas as caixinhas do cliente.
 */
async function reconciliarCaixinhas(grupoId, ofContaId, idsVistos) {
  if (!ofContaId) return 0;
  try {
    let q = supabase.from('of_caixinhas').delete()
      .eq('grupo_id', grupoId).eq('provider', PROVIDER).eq('of_conta_id', String(ofContaId));
    if (idsVistos.length) q = q.not('external_id', 'in', `(${idsVistos.map((i) => `"${i}"`).join(',')})`);
    const { error } = await q;
    return error ? 0 : 1;
  } catch { return 0; }   // migration 120 pendente (sem of_conta_id) → não reconcilia
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
  const relatorio = { contas: [], caixinhas: [], cartoes: [], dividas: [], investimentos: [], avisos: [] };

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
        const n = normalizeConta(raw, conexao.instituicao);
        const walletNome = await upsertWallet(grupoId, userId, n, n.saldo);
        const txs = await celcoin.listarTransacoesConta(n.externalId, { fromDate });
        const novas = await inserirTransacoes(grupoId, userId, walletNome, txs.map(normalizeTxConta));
        novasTx += novas;
        relatorio.contas.push({
          conta: walletNome, saldo: n.saldo, txs: txs.length, novas,
          pendente_sync: !n.sincronizado || undefined,
        });

        // 2b. CAIXINHAS (saldos reservados) — só quando o banco diz que existem.
        // Bloco à parte e tolerante: caixinha é informativa, e falha aqui não
        // pode derrubar a conta nem as transações, que são o essencial.
        if (raw.balance && raw.balance.has_reserved_balance === true) {
          try {
            const reservas = await celcoin.listarSaldosReservados(n.externalId);
            const vistos = [];
            let total = 0;
            for (const r of reservas) {
              const c = normalizeCaixinha(r, n.externalId);
              if (!c) continue;
              await upsertCaixinha(grupoId, userId, conexao.id, c);
              vistos.push(c.externalId);
              total = cent(total + c.saldo);
            }
            // Lista vazia é resposta VÁLIDA ("tem o produto, não tem reserva") —
            // e aí a reconciliação limpa o que sobrou de um sync anterior.
            await reconciliarCaixinhas(grupoId, n.externalId, vistos);
            relatorio.caixinhas.push({ conta: walletNome, quantidade: vistos.length, total });
          } catch (e) { relatorio.caixinhas.push({ conta: walletNome, erro: e.message }); }
        }
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

        // `null` quando a leitura FALHA — diferente de [] ("não tem parcelamento").
        // Com null a projeção gravada fica intacta (ver gravarParcelasPrevistas).
        let parcelamentos = null;
        let parcelamentosErro = null;
        try { parcelamentos = await celcoin.listarParcelamentos(n.externalId, { estrito: true }); }
        catch (e) { parcelamentos = null; parcelamentosErro = e.message; }

        const novas = await inserirTransacoes(grupoId, userId, walletNome, normalizadas);
        // ⚠️ O HISTÓRICO JÁ IMPORTADO FICOU NA DATA DA COMPRA. Ver
        // reconciliarParcelas: sem isto a fatura do cliente nunca fecha com a
        // do banco, por mais certo que o cálculo esteja.
        const parcelasCorrigidas = await reconciliarParcelas(grupoId, normalizadas);
        // Preenche a data de lançamento do emissor no histórico já importado
        // (migration 130). Aditivo: só onde está null.
        const bpdPreenchidas = await backfillBillPostDate(grupoId, normalizadas);
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
        // ⭐ Com a FATURA SIMULADA da Polp não há nada a estimar: o banco disse
        // quanto é a fatura em andamento. Todo o bloco abaixo (limite usado,
        // parcelas a vencer, soma das transações) existe só porque esse número
        // não existia. Tendo ele, qualquer estimativa nossa seria pior.
        // ⚠️ declarada AQUI de propósito: o relatório logo abaixo a lê, e com
        // ela dentro do `if` o bloco inteiro estourava ReferenceError — o
        // try/catch engolia e o cartão saía do sync como { erro: ... }.
        let estimada = null;
        const temSimulada = n.faturaSimulada != null;
        if (!temSimulada && !(n.faturaAberta && n.faturaAberta.total > 0)) {
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
          estimada = faturaPorTransacoes(normalizadas, txs, n, hoje);
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

        // O pagamento da fatura JÁ vinha como transação, mas nunca chegava em
        // `pagamentos_fatura` — que é de onde sai `restante = fatura − pago`.
        // Sem isto a fatura ficava eternamente "em aberto" no painel mesmo
        // depois de paga (queixa real). Tolerante: não derruba o sync.
        let pagamentosRegistrados = 0;
        // Parcelas que o BANCO já sabe que vão cair e a Sora não: o Mercado
        // Pago manda parcela sem o marcador "N/M", então a 2ª nunca vira
        // transação e a fatura FUTURA saía a menos (medido: 282,27 onde o app
        // mostrava 558,78). Projeção — não vira transação.
        let parcelasProjetadas = 0;
        // Faturas PUBLICADAS pelo banco (migration 118). É o valor oficial —
        // até aqui a Sora recebia `bill_total_amount` a cada sync e descartava,
        // reconstruindo o número pela soma das transações importadas. Guardar
        // tira o valor da fatura do terreno da reconstrução (ver faturasBanco.js).
        let faturasSalvas = 0;
        try {
          const { data: w } = await supabase.from('wallets')
            .select('*')                       // '*': colunas novas (114) podem não existir
            .eq('grupo_id', grupoId).eq('of_conta_id', n.externalId).maybeSingle();
          if (w) {
            faturasSalvas = await salvarFaturas(grupoId, w.id, bills);
            pagamentosRegistrados = await registrarPagamentosDoOF(grupoId, w);
            // já buscado acima (antes do insert) — não pagar a chamada duas vezes
            // `normalizadas` entra pra NÃO projetar por cima do que o sync já
            // lançou: cartão que manda "N/M" tem a parcela futura redistribuída
            // como transação, e projetar de novo contaria em dobro.
            parcelasProjetadas = await gravarParcelasPrevistas(
              grupoId, w, parcelamentos, hoje, normalizadas);
          }
        } catch { /* ignora */ }

        relatorio.cartoes.push({
          cartao: walletNome, limite: n.extras.limite,
          fatura: n.faturaAberta, estimada: estimada != null || undefined,
          txs: txs.length, novas,
          pagamentos_fatura: pagamentosRegistrados || undefined,
          parcelas_previstas: parcelasProjetadas || undefined,
          // ⚠️ Observabilidade da redistribuição. Sem estes três campos, "a
          // fatura continua errada depois do sync" vira adivinhação: não dá pra
          // saber se a API não devolveu plano, se devolveu e nada casou, ou se
          // casou e o update falhou. Foi exatamente o que aconteceu.
          parcelamentos_lidos: parcelamentosErro ? `ERRO: ${parcelamentosErro}`
            : (parcelamentos ? parcelamentos.length : 0),
          parcelas_reconciliadas: parcelasCorrigidas || undefined,
          bill_post_date_preenchidas: bpdPreenchidas || undefined,
          faturas_banco: faturasSalvas || undefined,
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
          if (r === 'adotada') {
            relatorio.avisos.push(
              `${d.titulo}: já existia cadastrada à mão — a linha do usuário foi vinculada ao contrato do banco `
              + `(sem duplicar; valor e parcelas passam a vir do ${d.credor || 'banco'})`);
          }
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
      // Duplicata nasce AQUI: ou o provedor mandou a mesma compra duas vezes,
      // ou a pessoa já tinha digitado o que o banco acabou de trazer. Este é o
      // instante certo pro Watson olhar — e ele só fala do que apareceu nas
      // últimas 24h, pra não repetir o mesmo alerta a cada sync.
      require('./duplicadas').avisarDuplicadasEmBackground(grupoId, null);
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
  normalizeConta, normalizeCaixinha, normalizeCartao, normalizeTxConta, normalizeTxCartao, faturaPorTransacoes,
  descricaoTx, documentoMascarado,
  normalizeDivida, normalizeInvestimento, ultimaFaturaPublicada, faturaPorLimite,
  mesmaDividaManual, normTexto,
  limiteTotalDoCartao, escolherFaturaAberta, pagoDaFatura, tipoInvestimento, diaMaisFrequente,
  faturaSimulada, unbilledDoCartao, usadoDoCartao, usoConhecido,
  analisarParcelamentos, normalizeParcelamento, assinaturaCompra,
  parcelaDaDescricao, parcelaDaTx, baseSemMarcador, dataDaParcela, grupoDaParcela,
};
