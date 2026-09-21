// =============================================================================
// CASAR PREVISÃO × COBRANÇA DO BANCO — fonte única.
//
// Quando o Open Finance traz a cobrança real de uma conta fixa, esta função diz
// QUAL previsão ela quita. É usada em DOIS lugares, e de propósito:
//
//   · `/api/previstos/ocorrencias` → devolve como SUGESTÃO ("o banco confirmou
//     esta cobrança, dar baixa?"), que é o padrão;
//   · o sync do Open Finance → quita sozinho, quando `users.baixa_automatica`
//     está ligado.
//
// Uma função só para os dois. Duas cópias divergiriam, e o sintoma seria o pior
// possível: a tela sugerindo uma coisa e o sync quitando outra.
//
// ── ⚠️ O NOME NÃO ENTRA NO CASAMENTO ────────────────────────────────────────
//
// É a pergunta que o dono do produto fez: "o nome tem que ser exatamente igual
// ao que o banco envia?". Não — e não pode ser, porque o nome do banco quase
// nunca é o que a pessoa digitou.
//
// Isso não é opinião, é lição medida nesta base. `parcelasPrevistas.js`
// registra que a Polp manda a MESMA compra duas vezes com descrições
// diferentes (`JIM.COM PROSED ES` × `JIM.COM PROSED ESPECIALID`, 1 centavo de
// diferença) e que casar por descrição devolvia **zero** duplicatas. O Watson
// (`duplicadas.js`) chegou à mesma conclusão.
//
// O que casa é o que o banco e a previsão realmente têm em comum:
//
//   CARTEIRA  obrigatória  — a cobrança tem de sair da conta certa
//   VALOR     em DUAS bandas (ver abaixo)
//   DATA      ±5 dias      — cobre pagamento adiantado e atrasado
//
// ── ⚠️ VALOR EM DUAS BANDAS (set/2026) ──────────────────────────────────────
//
// Relato de cliente: a conta de Internet prevista em R$169,90 veio do banco
// por R$177,53 (o plano reajustou) — a "Internet" ficava PARA SEMPRE como
// previsão em aberto, convivendo na tela com a transação real já paga, porque
// R$7,63 é mais que a tolerância apertada. Ele via os dois ao mesmo tempo e
// achava (com razão) que estava duplicado — e pediu uma "conciliação manual".
//
// A banda apertada (±R$1) continua a mesma, e continua sendo a ÚNICA que pode
// virar baixa AUTOMÁTICA — essa garantia não muda. O que muda: quando NADA
// casa na banda apertada, uma segunda passada tenta uma banda LARGA (30% do
// valor previsto, nunca menos que R$1) — e o resultado dessa passada É SEMPRE
// SUGESTÃO, nunca automático, mesmo numa conta que não é `valor_variavel`. A
// conta fixa que balança um pouco de mês pra mês (a internet, a luz sem ser
// marcada como variável) ganha a mesma cortesia que já existia só pra quem
// marcou o campo — sem abrir mão da segurança do `baixa_automatica`.
//
// ── ⚠️ O PROBLEMA DIFÍCIL NÃO É ACHAR, É NÃO QUITAR A ERRADA ────────────────
//
// Mesma disciplina do Watson e do `mesmaDividaManual`: deixar uma previsão sem
// baixa custa um toque; quitar a previsão errada corrompe o saldo e a pessoa
// não tem como desconfiar. Por isso:
//
//   1. AMBIGUIDADE NUNCA VIRA BAIXA AUTOMÁTICA. Se duas previsões casam com a
//      mesma cobrança (ou duas cobranças com a mesma previsão), o resultado sai
//      como sugestão, sempre — mesmo com a chave ligada.
//   2. CONTA DE VALOR VARIÁVEL NUNCA É AUTOMÁTICA. O valor é o sinal forte do
//      casamento; numa conta que varia, ele não existe.
//   3. BANDA LARGA NUNCA É AUTOMÁTICA. Só a banda apertada dá certeza o
//      bastante pra quitar sozinha.
//   4. Só entra transação que VEIO DO BANCO (`of_tx_id`) e que ainda não está
//      amarrada a nenhuma ocorrência.
// =============================================================================

const TOLERANCIA_VALOR      = 1.00;   // R$ — igual ao parcelasPrevistas (banda apertada, elegível a automático)
const TOLERANCIA_AMPLA_PCT  = 0.30;   // 30% do valor previsto — banda larga, NUNCA automática
const JANELA_DIAS           = 5;

const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Normaliza nome de carteira: sem acento, sem caixa, sem espaço sobrando. */
function normCarteira(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
}

function diasEntre(a, b) {
  const [a1, m1, d1] = String(a).slice(0, 10).split('-').map(Number);
  const [a2, m2, d2] = String(b).slice(0, 10).split('-').map(Number);
  return Math.round((new Date(a2, m2 - 1, d2) - new Date(a1, m1 - 1, d1)) / 86400000);
}

/**
 * @param previsoes  [{ recorrencia_id, competencia, vencimento (YYYY-MM-DD),
 *                      valor, carteira, tipo, valor_variavel }]
 * @param transacoes [{ id, data, valor, tipo, carteira_nome, of_tx_id,
 *                      recorrencia_id }]
 * @returns [{ recorrencia_id, competencia, transacao_id, data, valor,
 *             automatico: boolean, motivo?: string }]
 */
function casar(previsoes, transacoes) {
  const candidatas = (transacoes || []).filter((t) =>
    t && t.of_tx_id && !t.recorrencia_id && Number(t.valor) > 0);

  // 1ª passada: para cada previsão, quais cobranças servem.
  const porPrevisao = new Map();
  for (const p of previsoes || []) {
    if (!p || !p.recorrencia_id || !p.competencia || !p.vencimento) continue;
    const alvo = cent(p.valor);
    if (!(alvo > 0)) continue;
    const carteiraP = normCarteira(p.carteira);

    // CARTEIRA, TIPO e JANELA são o filtro base — a banda de valor entra
    // depois, em duas tentativas.
    const base = candidatas.filter((t) => {
      if (p.tipo && t.tipo && p.tipo !== t.tipo) return false;
      // ⚠️ Carteira é OBRIGATÓRIA. Sem ela não dá pra afirmar que a cobrança é
      // desta conta, e "quase certo" aqui vale zero.
      if (!carteiraP || normCarteira(t.carteira_nome) !== carteiraP) return false;
      return Math.abs(diasEntre(p.vencimento, t.data)) <= JANELA_DIAS;
    });

    let achadas = base.filter((t) => Math.abs(cent(t.valor) - alvo) <= TOLERANCIA_VALOR);
    let aproximado = false;
    // Só tenta a banda larga quando a apertada não achou nada — se já achou
    // dentro da banda de confiança, não vale a pena arriscar trazer junto uma
    // cobrança mais distante e só criar ambiguidade à toa.
    if (!achadas.length) {
      const folga = Math.max(TOLERANCIA_VALOR, alvo * TOLERANCIA_AMPLA_PCT);
      achadas = base.filter((t) => Math.abs(cent(t.valor) - alvo) <= folga);
      aproximado = achadas.length > 0;
    }
    if (achadas.length) porPrevisao.set(`${p.recorrencia_id}:${p.competencia}`, { p, achadas, aproximado });
  }

  // 2ª passada: quantas previsões disputam CADA cobrança.
  const disputasPorTx = new Map();
  for (const { achadas } of porPrevisao.values()) {
    for (const t of achadas) disputasPorTx.set(t.id, (disputasPorTx.get(t.id) || 0) + 1);
  }

  const saida = [];
  for (const { p, achadas, aproximado } of porPrevisao.values()) {
    // Mais perto do vencimento primeiro — o empate é resolvido pela data, que é
    // o critério mais defensável quando os valores são idênticos.
    const t = [...achadas].sort((x, y) =>
      Math.abs(diasEntre(p.vencimento, x.data)) - Math.abs(diasEntre(p.vencimento, y.data)))[0];

    const variasCobrancas = achadas.length > 1;
    const variasPrevisoes = (disputasPorTx.get(t.id) || 0) > 1;
    const variavel        = !!p.valor_variavel;

    // ⚠️ AQUI MORA A SEGURANÇA. Qualquer sombra de dúvida derruba o automático
    // pra sugestão — a chave global governa só o caso limpo.
    const automatico = !variasCobrancas && !variasPrevisoes && !variavel && !aproximado;
    // ⚠️ Texto voltado pro CLIENTE — `ExtratoFuturo.tsx` mostra isto cru, sem
    // dicionário de tradução ("Confira antes: {motivo}."). Frase curta, com
    // acento, que faz sentido depois de dois-pontos.
    const motivo = variasPrevisoes ? 'outra conta fixa bate com a mesma cobrança'
      : variasCobrancas ? 'mais de uma cobrança parecida nesses dias'
      : variavel ? 'o valor desta conta costuma variar'
      : aproximado ? 'o valor veio um pouco diferente do previsto'
      : undefined;

    saida.push({
      recorrencia_id: p.recorrencia_id,
      competencia:    p.competencia,
      transacao_id:   t.id,
      data:           String(t.data).slice(0, 10),
      valor:          cent(t.valor),
      automatico,
      motivo,
    });
  }
  return saida;
}

module.exports = { casar, TOLERANCIA_VALOR, TOLERANCIA_AMPLA_PCT, JANELA_DIAS, normCarteira, diasEntre };
