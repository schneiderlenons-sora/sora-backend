// =============================================================================
// ARITMÉTICA DO ORÁCULO — "essa compra cabe no meu bolso?"
//
// Função PURA: recebe a foto financeira já lida do banco e devolve o veredito.
// Sem I/O de propósito, pra ter eval (evals/saudeCompra.eval.js). Quem busca os
// dados e formata a mensagem é handlers/oraculo.js.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ A REGRA QUE GOVERNA ESTE ARQUIVO: SABER QUANDO NÃO SABE.
//
// Medido na base antes de escrever: só 35% dos grupos pagantes têm receita fixa
// cadastrada e só 21% têm receita nos 3 últimos meses fechados. Ou seja, pra
// DOIS EM CADA TRÊS usuários a Sora não faz ideia de quanto a pessoa ganha.
//
// Um "pode comprar" chutado nesse cenário não é imprecisão de número — é a
// pessoa assumindo 10×R$500 que não cabe porque a Sora disse que cabia. Então
// sem renda confiável este arquivo NÃO devolve veredito: devolve o que
// conseguiu provar e diz o que falta.
//
// Pelo mesmo motivo, cada marcador da resposta ("faturas em dia", "renda
// estável") só existe quando foi MEDIDO. Nada é preenchido por padrão.
// =============================================================================

const cent = (v) => Math.round(Number(v) || 0);

/** Mediana — resistente ao 13º e ao reembolso avulso, que a média engoliria. */
function mediana(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// ── Parâmetros do critério CONSERVADOR (decisão do dono) ────────────────────
// Não viram env var: são regra de produto, e um número desses mudando sem
// deploy é justamente o tipo de coisa que ninguém audita depois.
const MAX_OCUPACAO_FOLGA = 0.30;  // a parcela nova não passa de 30% da folga
const MESES_RESERVA      = 1;     // sobra ao menos 1 mês de despesa em caixa
const VARIACAO_ESTAVEL   = 0.20;  // até 20% de oscilação = "renda estável"

// ⚠️ PORTÃO DE COERÊNCIA — renda abaixo disto × a saída significa que a Sora
// NÃO CONHECE a renda, não que a pessoa está quebrada.
//
// Medido na base (68 grupos Premium/Platinum), a razão renda/saída se separa
// em dois blocos sem meio-termo:
//     reais → 118% · 92% · 91% · 75%
//     lixo  →   5% ·  4% ·  2% · 0,4% · 0,1% · 0,0%
// O bloco de baixo são linhas de rendimento de conta, cashback e cadastros de
// teste (existem recorrências de Recebimento de R$ 0,05 e R$ 0,15 na base).
// Ninguém gasta 20× o que ganha, todo mês, por três meses.
//
// 30% cai no vão entre os dois blocos. Abaixo disso o veredito é recusado e a
// resposta pede a renda — dizer "você não pode comprar nada" com convicção,
// por causa de uma linha de R$ 0,05, queima a confiança igual a um "pode"
// errado.
const MIN_RAZAO_RENDA_SAIDA = 0.30;

/**
 * Renda mensal + o quanto dá pra confiar nela.
 *
 * @param {Array}  recorrenciasReceita  [{ valor }] recorrências ativas de Recebimento
 * @param {Array}  receitaPorMes        [n, n, n] receita dos 3 meses FECHADOS
 * @returns {{ valor:number|null, fonte:'fixa'|'historico'|null,
 *             estavel:boolean, variacao:number|null }}
 */
function calcularRenda(recorrenciasReceita, receitaPorMes) {
  const fixa = (recorrenciasReceita || []).reduce((s, r) => s + cent(r.valor), 0);

  // Histórico: só os 3 meses FECHADOS. O mês corrente está pela metade e
  // puxaria a renda pra baixo sem significar nada.
  const meses = (receitaPorMes || []).filter((n) => Number.isFinite(n) && n > 0);
  let hist = null, variacao = null, estavelHist = false;
  if (meses.length >= 3) {
    const med = mediana(meses);
    variacao = med > 0 ? Math.max(...meses.map((v) => Math.abs(v - med))) / med : 1;
    estavelHist = variacao <= VARIACAO_ESTAVEL;
    // ⚠️ RENDA QUE OSCILA USA O PIOR MÊS, NÃO A MÉDIA. Medido na base: entre
    // quem tem os 3 meses, a receita variou 36%, 49%, 56% e até 114%. Aprovar
    // um parcelamento de 10 meses pela média de uma renda que despenca à
    // metade é exatamente como alguém quebra — a parcela é fixa, a renda não.
    hist = estavelHist ? med : Math.min(...meses);
  }

  if (!fixa && hist == null) return { valor: null, fonte: null, estavel: false, variacao: null };

  // ⚠️ `max`, E NÃO "a fixa tem prioridade" — foi assim que começou e estava
  // ERRADO. Medido na base: existem recorrências de Recebimento de R$ 0,05,
  // R$ 0,15, R$ 0,22 e R$ 29 (rendimento de conta, cashback, linha de teste).
  // Dando prioridade à fixa, uma delas virava "a renda do usuário" e o Oráculo
  // respondia um NÃO confiante a quem movimenta R$ 27 mil por mês. Errar com
  // convicção pro lado do "não" destrói a confiança tanto quanto pro lado do
  // "sim".
  //
  // A receita cadastrada é um PISO declarado, não um retrato completo (quase
  // ninguém cadastra o freela). O histórico é o que de fato entrou. O maior
  // dos dois é o mais próximo da verdade — e é simétrico ao `calcularSaida`,
  // que já faz o mesmo do lado da despesa. Comparar uma renda parcial com uma
  // despesa completa era o que fazia todo mundo parecer quebrado.
  if (hist == null || fixa >= hist) {
    return { valor: fixa, fonte: 'fixa', estavel: true, variacao: null };
  }
  return { valor: hist, fonte: 'historico', estavel: estavelHist, variacao };
}

/**
 * Saída mensal. ⚠️ É `max`, NUNCA soma — e isso é o ponto mais delicado do
 * arquivo.
 *
 * Os dois lados são visões COMPLETAS da mesma saída: `compromissos` olha pra
 * frente (o que está contratado) e `mediaHistorica` olha pra trás (o que de
 * fato saiu, já incluindo fatura, recorrência e gasto variável). Somar os dois
 * conta tudo duas vezes.
 *
 * E há um caso concreto que torna a soma inaceitável: MEDIDO, 21 recorrências
 * ativas (R$ 1.807,43/mês) apontam para um CARTÃO DE CRÉDITO — o cron lança a
 * despesa no cartão e ela reaparece dentro da fatura. Somar "recorrências +
 * fatura" duplicaria esse dinheiro. Pegar o maior dos dois é imune a isso e é
 * o lado conservador.
 */
function calcularSaida(compromissos, mediaHistorica) {
  const c = cent(compromissos);
  const h = cent(mediaHistorica);
  return {
    valor: Math.max(c, h),
    fonte: h > c ? 'historico' : 'compromissos',
    compromissos: c,
    historico: h,
  };
}

/**
 * Limite disponível do cartão.
 *
 * ⚠️ NO BRASIL, COMPRA PARCELADA CONSOME O LIMITE INTEIRO NA HORA e libera mês
 * a mês. Conferir a PARCELA contra o limite aprovaria uma compra que a máquina
 * recusa na frente do vendedor. A comparação é sempre contra o valor TOTAL.
 *
 * @param {object} cartao { limite, faturaAberta, parcelasFuturas }
 */
function limiteDisponivel(cartao) {
  if (!cartao || !(Number(cartao.limite) > 0)) return null;   // sem limite → não afirma nada
  const usado = cent(cartao.faturaAberta) + cent(cartao.parcelasFuturas);
  return Math.max(0, cent(cartao.limite) - usado);
}

/**
 * O veredito.
 *
 * @param {object} compra  { total, parcela, parcelas, noCartao }  (CENTAVOS)
 * @param {object} foto {
 *   renda:            saída de calcularRenda
 *   saida:            saída de calcularSaida
 *   caixa:            centavos disponíveis (carteiras não-crédito)
 *   cartao:           { nome, limite, faturaAberta, parcelasFuturas } | null
 *   faturasEmDia:     boolean | null   (null = não deu pra apurar)
 * }
 * @returns {{ tier, veredito, motivos[], faltando[], numeros{} }}
 *   tier: 'veredito' | 'parcial' | 'nao_sei'
 *   veredito: 'pode' | 'cuidado' | 'nao' | null
 */
function avaliarCompra(compra, foto) {
  const { renda, saida, caixa, cartao, faturasEmDia } = foto;
  const parcelas = Math.max(1, compra.parcelas || 1);
  const parcela  = cent(compra.parcela != null ? compra.parcela : compra.total / parcelas);
  const total    = cent(compra.total);

  // ── Cartão: cabe no limite? ───────────────────────────────────────────────
  // `null` em qualquer ponto significa "não apurei", e é diferente de `false`.
  const disp = limiteDisponivel(cartao);
  const usaCartao = compra.noCartao === true
    || (compra.noCartao == null && parcelas > 1 && !!cartao);
  const cabeNoCartao = (usaCartao && disp != null) ? total <= disp : null;

  const numeros = {
    parcela, total, parcelas,
    caixa: cent(caixa),
    renda: renda.valor,
    saida: saida.valor,
    folga: renda.valor == null ? null : cent(renda.valor - saida.valor),
    limiteDisponivel: disp,
    ocupacao: null,
    reservaAlvo: cent(saida.valor) * MESES_RESERVA,
  };

  // ⚠️ Renda desproporcional à saída = renda DESCONHECIDA, não pessoa quebrada.
  // Ver MIN_RAZAO_RENDA_SAIDA: é o que impede uma recorrência de R$ 0,05 de
  // virar "a renda do usuário" e produzir um NÃO categórico contra quem
  // movimenta dezenas de milhares por mês.
  const rendaIncoerente = renda.valor != null && saida.valor > 0
    && renda.valor < saida.valor * MIN_RAZAO_RENDA_SAIDA;

  // ⚠️ Saída ZERO não é "não gasta nada" — é "não sei o que sai".
  // Caso real medido: uma conta com R$ 26,00 de receita cadastrada, nenhuma
  // despesa fixa e nenhum histórico recebia um NÃO categórico, porque a folga
  // de R$ 26 não cobria a compra. Não há retrato financeiro nenhum ali.
  // Veredito exige as DUAS pontas conhecidas.
  const semSaida = !(saida.valor > 0);

  const faltando = [];
  if (renda.valor == null || rendaIncoerente) faltando.push('renda');
  if (usaCartao && disp == null) faltando.push('limite');
  if (semSaida) faltando.push('despesas');

  // ── TIER 1: sem os dois lados não há veredito. Nunca. ────────────────────
  if (renda.valor == null || rendaIncoerente || semSaida) {
    const temAlgo = numeros.caixa > 0 || saida.valor > 0 || disp != null;
    return {
      tier: temAlgo ? 'parcial' : 'nao_sei',
      veredito: null,
      rendaIncoerente,
      // Com renda incoerente o marcador de renda NÃO é impresso: mostrar
      // "Renda: R$ 0,05" ao lado de "Sai por mês: R$ 27.852" faria a Sora
      // parecer quebrada, não honesta.
      motivos: montarMotivos({
        numeros, cartao, cabeNoCartao, faturasEmDia, saida,
        renda: rendaIncoerente ? { valor: null } : renda,
      }),
      faltando,
      numeros,
    };
  }

  const folga = numeros.folga;
  numeros.ocupacao = folga > 0 ? parcela / folga : null;

  // ── As quatro regras do critério conservador ─────────────────────────────
  // Separadas em "bloqueia" e "aperta" de propósito: estourar a reserva é um
  // alerta; não caber no mês (ou no cartão) é um não.
  const regras = {
    // 1. a parcela não pode ocupar mais de 30% da folga
    ocupacao: folga > 0 && parcela <= folga * MAX_OCUPACAO_FOLGA,
    // 2. TODO mês do parcelamento fecha positivo
    todoMesPositivo: folga - parcela > 0,
    // 3. sobra reserva de 1 mês depois da entrada
    reserva: (numeros.caixa - (parcelas > 1 ? 0 : total)) >= numeros.reservaAlvo,
    // 4. cabe no cartão (só quando aplicável)
    cartao: cabeNoCartao !== false,
    // 5. ⚠️ NÃO EXISTE "PODE COMPRAR" COM FATURA VENCIDA EM ABERTO.
    //    A conta pode fechar na planilha e ainda assim a pessoa estar atrasada
    //    hoje — e aí a resposta se contradizia sozinha: dizia "Pode comprar" e
    //    logo abaixo listava "⚠️ fatura vencida". Quem não está dando conta do
    //    que já deve não deve ouvir da Sora que pode assumir mais 10 meses.
    //    Não bloqueia a compra (isso é escolha de quem paga), mas nunca abençoa.
    //    `null` = não apurado, e não apurado não vira acusação.
    faturasEmDia: faturasEmDia !== false,
  };

  let veredito;
  if (!regras.todoMesPositivo || !regras.cartao) veredito = 'nao';
  else if (!regras.ocupacao || !regras.reserva || !regras.faturasEmDia) veredito = 'cuidado';
  else                                           veredito = 'pode';

  return {
    tier: 'veredito',
    veredito,
    regras,
    motivos: montarMotivos({ numeros, cartao, cabeNoCartao, faturasEmDia, renda, saida }),
    faltando,
    numeros,
  };
}

/**
 * Os marcadores da resposta ("• Renda estável", "• Faturas em dia").
 *
 * ⚠️ CADA UM SÓ APARECE SE FOI MEDIDO. Imprimir "Renda estável" pra quem
 * oscila 56% — ou "Faturas em dia" sem ter olhado fatura nenhuma — é dizer ao
 * usuário que a Sora conferiu algo que ela não conferiu. É o tipo de linha que
 * faz a pessoa confiar no veredito errado.
 */
function montarMotivos({ numeros, cartao, cabeNoCartao, faturasEmDia, renda, saida }) {
  const m = [];

  if (numeros.caixa > 0) m.push({ chave: 'caixa', bom: true, valor: numeros.caixa });

  if (cabeNoCartao != null) {
    m.push({
      chave: 'limite', bom: cabeNoCartao,
      valor: numeros.limiteDisponivel,
      limite: cent(cartao && cartao.limite),
      nome: cartao && cartao.nome,
    });
  }

  if (faturasEmDia != null) m.push({ chave: 'faturas', bom: !!faturasEmDia });

  if (renda.valor != null) {
    m.push({
      chave: 'renda', bom: renda.estavel, valor: renda.valor,
      fonte: renda.fonte, variacao: renda.variacao,
    });
  }

  if (saida.valor > 0) m.push({ chave: 'saida', bom: true, valor: saida.valor, fonte: saida.fonte });

  return m;
}

module.exports = {
  avaliarCompra,
  calcularRenda,
  calcularSaida,
  limiteDisponivel,
  mediana,
  MAX_OCUPACAO_FOLGA,
  MESES_RESERVA,
  VARIACAO_ESTAVEL,
  MIN_RAZAO_RENDA_SAIDA,
};
