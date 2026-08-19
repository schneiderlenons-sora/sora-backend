// =============================================================================
// Parcelas A VENCER de compras parceladas — o que falta pra fatura FUTURA bater
// com a do banco.
//
// PROBLEMA (medido na conta de um cliente, ago/2026): a fatura de setembro saía
// R$ 282,27 onde o app do banco mostrava R$ 558,78. Os R$ 276,51 de diferença
// eram três parcelas que a Sora não conhecia:
//     Prosed 79,86 · PayU Adidas 139,99 · Chinoca 56,66
// O Mercado Pago manda parcela SEM o marcador "N/M" na descrição, e é dele que
// `normalizeTxCartao` depende pra redistribuir. Sem marcador, a 2ª parcela
// nunca vira transação — ela só existe no endpoint `parcelamentos`.
//
// ⚠️ ISTO NÃO CRIA TRANSAÇÃO. A projeção é exibida e somada, marcada como
// "prevista pelo banco", e vive numa tabela própria que é reescrita a cada
// sync. Já existiu uma `sql/078` só pra limpar parcela futura importada errada
// — gravar projeção em `transacoes` é repetir aquele erro.
//
// DUAS DECISÕES QUE FAZEM A CONTA FECHAR:
//
// 1. DEDUP POR INSTANTE DA COMPRA, não por descrição.
//    A Polp manda a MESMA compra duas vezes, com texto e 1 centavo diferentes:
//        JIM.COM PROSED ES          79,86  2x  2026-08-03T22:31:55
//        JIM.COM PROSED ESPECIALID  79,87  2x  2026-08-03T22:31:55
//    A dedup antiga casava por `descrição|valor|parcelas` e por isso achava
//    ZERO duplicatas justamente nesses casos. Duas compras de verdade não
//    acontecem no MESMO SEGUNDO, no mesmo cartão, com o mesmo parcelamento.
//
// 2. A PROJEÇÃO É GUIADA POR DATA, não por `paidInstallments`.
//    A Polp erra esse campo (documentado no CLAUDE.md) — o Chinoca vinha "3 de
//    3 pagas" com uma parcela ainda por vencer. Em vez de confiar nele,
//    projetamos TODAS as parcelas pelos ciclos (parcela n cai n−1 ciclos depois
//    da compra) e ficamos só com as de competência FUTURA. Validado: devolve
//    as três parcelas que faltavam, nas competências certas.
//
// ⚠️ PRECISÃO: pode dar UM CENTAVO a mais por compra. A API informa a parcela
// NOMINAL (Chinoca 56,67) e, num 3x, o arredondamento sobra na ÚLTIMA parcela,
// que o banco cobra 56,66. O payload não traz o total da compra pra recalcular
// — e inventar a diferença seria pior que assumi-la. É por isso que estas
// linhas aparecem rotuladas como "previstas pelo banco": aproximam a fatura
// que ainda não fechou, não prometem o centavo.
// =============================================================================

const { competenciaAtual, competenciaVizinha, cicloPorCompetencia } = require('./cicloFatura');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymd = (d) => (d ? String(d).slice(0, 10) : null);
/** Instante ao SEGUNDO (descarta milissegundo e fuso textual). */
const instante = (d) => (d ? String(d).slice(0, 19) : '');

/** Achata um parcelamento cru da Polp no formato que usamos. */
function normalizar(p) {
  const g = (...ks) => { for (const k of ks) if (p && p[k] != null) return p[k]; return null; };
  const ocor = g('occurrences');
  return {
    descricao:     String(g('description') || '').trim(),
    valorParcela:  Math.abs(cent(g('amount'))),
    totalParcelas: Number(g('totalInstallments', 'total_installments')) || 0,
    compradoEm:    g('purchasedAt', 'purchased_at'),
    // Guardado só pra diagnóstico — a projeção NÃO usa (a Polp erra este campo).
    encontradas:   Number(g('paidInstallments', 'paid_installments')) || (Array.isArray(ocor) ? ocor.length : 0),
  };
}

/**
 * Junta as linhas que são a MESMA compra.
 *
 * Chave: instante da compra (ao segundo) + total de parcelas. O valor entra com
 * tolerância de R$ 1 — a duplicata da Polp difere em centavos, e exigir valor
 * idêntico deixaria as duas passarem (foi o que aconteceu).
 *
 * Entre as duplicatas fica a de MENOR valor de parcela: nos dois pares reais
 * medidos (79,86/79,87 e 139,99/140,00) o app do banco mostrava a menor.
 */
function deduplicar(lista) {
  const itens = (Array.isArray(lista) ? lista : []).map(normalizar)
    .filter((it) => it.totalParcelas > 1 && it.valorParcela > 0 && it.compradoEm);

  const grupos = [];
  for (const it of itens) {
    const igual = grupos.find((g) =>
      instante(g.compradoEm) === instante(it.compradoEm)
      && g.totalParcelas === it.totalParcelas
      && Math.abs(g.valorParcela - it.valorParcela) <= 1);
    if (!igual) { grupos.push({ ...it }); continue; }
    if (it.valorParcela < igual.valorParcela) {
      igual.valorParcela = it.valorParcela;
      igual.descricao = it.descricao;
    }
  }
  return grupos;
}

/**
 * Parcelas que ainda vão cair, por competência.
 *
 * @param {Array}  lista   parcelamentos crus da Polp
 * @param {object} cartao  { dia_fechamento, dia_vencimento }
 * @param {string} hoje    'YYYY-MM-DD'
 * @returns {Array<{competencia, descricao, valor, parcela, total, assinatura}>}
 *
 * Devolve da competência ATUAL pra frente. O que nunca é projetado é a
 * PARCELA 1 na competência dela: a compra em si sempre chega pelo extrato, e
 * projetar por cima contaria em dobro.
 *
 * ⚠️ Antes isto excluía a competência atual inteira, com a justificativa de que
 * "a compra do ciclo em curso já veio pelo extrato". A justificativa vale pra
 * COMPRA (parcela 1), não pra PARCELA. Medido na conta de um cliente (Itaú, que
 * também não manda o marcador "N/M"): a fatura em curso saía R$ 218,70 contra
 * R$ 706,08 no app do banco, faltando a parcela 5/9 de R$ 347,52 — que não é
 * transação nenhuma e só existe em `parcelamentos`. A fatura JÁ FECHADA do
 * mesmo cartão prova a regra: transações R$ 2.406,28 + a parcela R$ 347,52 dão
 * exatamente os R$ 2.753,80 que o banco publicou.
 *
 * As linhas do ciclo em curso saem marcadas com `emCurso`, porque a dedup
 * delas é mais rígida (ver jaEhTransacao).
 */
function projetar(lista, cartao, hoje) {
  if (!cartao || !cartao.dia_fechamento) return [];   // sem ciclo, sem projeção
  const atual = competenciaAtual(cartao, hoje);
  const out = [];

  for (const c of deduplicar(lista)) {
    const compraEm = ymd(c.compradoEm);
    if (!compraEm) continue;
    // Competência da 1ª parcela = a fatura em que a COMPRA caiu.
    const compCompra = competenciaAtual(cartao, compraEm);

    for (let n = 1; n <= c.totalParcelas; n++) {
      const comp = n === 1 ? compCompra : competenciaVizinha(cartao, compCompra, n - 1);
      if (comp < atual) continue;                     // fatura já fechada
      // A COMPRA sempre chega pelo extrato na competência dela.
      if (comp === atual && n === 1) continue;
      out.push({
        competencia: comp,
        emCurso:     comp === atual,
        descricao:   c.descricao,
        valor:       c.valorParcela,
        parcela:     n,
        total:       c.totalParcelas,
        // Estável entre syncs — é a chave de reescrita da projeção.
        assinatura:  `${instante(c.compradoEm)}|${c.totalParcelas}|${c.valorParcela.toFixed(2)}`,
      });
    }
  }
  return out.sort((a, b) => a.competencia.localeCompare(b.competencia) || b.valor - a.valor);
}

/**
 * A parcela projetada JÁ EXISTE como transação?
 *
 * ⚠️ ESTE É O RISCO CARO DESTE MÓDULO. Cartão que manda o marcador "N/M" na
 * descrição (Nubank) tem as parcelas futuras REDISTRIBUÍDAS pelo sync e já
 * lançadas como transação. Projetar por cima delas contaria a mesma parcela
 * duas vezes e a fatura sairia MAIOR que a do banco — o inverso exato do bug
 * que este módulo veio corrigir. O Mercado Pago, que não manda o marcador, não
 * casa com nada aqui e segue sendo projetado.
 *
 * Casa por parcela (n de N) + valor com folga de R$ 1 (a mesma folga da dedup:
 * a API informa a parcela nominal e o banco arredonda a última).
 *
 * ⚠️ NO CICLO EM CURSO a checagem é MAIS RÍGIDA (`emCurso`): vale também
 * transação SEM marcador, desde que caia dentro do ciclo e bata no centavo.
 * Sem isso, um banco que poste a parcela como linha comum faria a fatura EM
 * ABERTO — a que o usuário olha todo dia — sair maior que a do banco. Nas
 * competências futuras esse casamento por valor não existe de propósito: lá
 * qualquer compra de valor parecido cancelaria uma parcela real.
 */
function jaEhTransacao(linha, txsDoCartao, cartao) {
  const lista = txsDoCartao || [];
  const porMarcador = lista.some((t) => {
    const total = Number(t && t.parcela_total);
    const num = Number(t && t.parcela_num);
    if (!total || !num) return false;
    if (total !== linha.total || num !== linha.parcela) return false;
    return Math.abs(Math.abs(Number(t.valor) || 0) - linha.valor) <= 1;
  });
  if (porMarcador) return true;
  if (!linha || !linha.emCurso || !cartao || !cartao.dia_fechamento) return false;

  let ciclo;
  try { ciclo = cicloPorCompetencia(cartao, linha.competencia); } catch { return false; }
  if (!ciclo) return false;
  return lista.some((t) => {
    if (!t) return false;
    const d = String(t.data || '').slice(0, 10);
    if (!(d >= ciclo.ini && d < ciclo.fimExcl)) return false;
    return Math.abs(Math.abs(Number(t.valor) || 0) - linha.valor) <= 0.01;
  });
}

/** Só as de uma competência + o total. */
function daCompetencia(previstas, competencia) {
  const linhas = (previstas || []).filter((p) => p.competencia === competencia);
  return { linhas, total: cent(linhas.reduce((s, p) => s + p.valor, 0)) };
}

/**
 * Regrava a projeção do cartão (migration 116).
 *
 * É PROJEÇÃO, não histórico: apaga tudo do cartão e regrava a cada sync. Se a
 * dedup errar hoje, o erro some amanhã — em `transacoes` viraria lixo no
 * histórico do usuário (foi o que a `sql/078` teve de limpar).
 *
 * O supabase é exigido aqui dentro de propósito: o miolo acima é puro e roda no
 * eval sem banco nem env.
 *
 * @returns {Promise<number>} quantas parcelas ficaram projetadas
 */
async function gravarParcelasPrevistas(grupoId, cartao, parcelamentos, hoje, txsDoCartao) {
  try {
    if (!grupoId || !cartao?.id) return 0;
    const supabase = require('../db/supabase');
    // Fora as que o sync já lançou como transação (ver jaEhTransacao) — senão a
    // mesma parcela contaria duas vezes em cartão que manda "N/M".
    const linhas = projetar(parcelamentos, cartao, hoje)
      .filter((l) => !jaEhTransacao(l, txsDoCartao, cartao));

    const { error: errDel } = await supabase.from('of_parcelas_previstas')
      .delete().eq('cartao_id', cartao.id);
    if (errDel) return 0;                    // migration 116 pendente
    if (!linhas.length) return 0;

    const { error } = await supabase.from('of_parcelas_previstas').insert(
      linhas.map((l) => ({
        grupo_id: grupoId, cartao_id: cartao.id,
        competencia: l.competencia, descricao: l.descricao, valor: l.valor,
        parcela_num: l.parcela, parcela_total: l.total, assinatura: l.assinatura,
      })));
    return error ? 0 : linhas.length;
  } catch { return 0; }
}

/**
 * Lê a projeção gravada (migration 116) de uma competência.
 *
 * Mora aqui pra ser a MESMA leitura em todo mundo que exibe fatura — a rota das
 * faturas e o feed da agenda já divergiram por cada um ter a sua conta, que foi
 * o motivo de `faturaVista` existir. Tolerante: sem a migration devolve vazio
 * e a tela só some com o bloco.
 */
async function lerPrevistas(cartaoId, competencia) {
  try {
    const supabase = require('../db/supabase');
    const { data, error } = await supabase.from('of_parcelas_previstas')
      .select('descricao, valor, parcela_num, parcela_total')
      .eq('cartao_id', cartaoId).eq('competencia', competencia)
      .order('valor', { ascending: false });
    if (error) return { linhas: [], total: 0 };
    const linhas = data || [];
    return { linhas, total: cent(linhas.reduce((s, p) => s + (Number(p.valor) || 0), 0)) };
  } catch { return { linhas: [], total: 0 }; }
}

module.exports = {
  normalizar, deduplicar, projetar, daCompetencia, instante,
  jaEhTransacao, gravarParcelasPrevistas, lerPrevistas,
};
