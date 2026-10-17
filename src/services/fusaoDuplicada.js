// =============================================================================
// FUNDIR uma previsão manual com a cobrança real do banco — parte PURA.
//
// O caso: o usuário lançou um "previsto" à mão (ex.: "Consócio dos Unidos",
// pago=false) e o Open Finance trouxe a cobrança real (ex.: "PIX ENVIADO",
// pago=true, com of_tx_id). São a MESMA coisa entrando por dois caminhos — o
// Watson já detecta isso (`duplicadas.ehDuplicata` → 'manual-e-banco'). Hoje a
// única saída é APAGAR uma, e quem apaga a manual perde o rótulo que escreveu.
//
// "Fundir" resolve em um toque MANTENDO o rótulo do usuário: a linha do banco
// fica (é ela que tem `of_tx_id` e o saldo já aplicado), herda a
// descrição/categoria da previsão, e a previsão manual é removida.
//
// ── ⚠️ A REGRA INVIOLÁVEL: NUNCA DESCARTAR A LINHA DO BANCO ─────────────────
//
// Quem fica é SEMPRE a transação com `of_tx_id`. Dois motivos, os dois graves
// se invertidos:
//   1. `of_tx_id` é o que protege contra REIMPORTAÇÃO — o sync deduplica por
//      ele. A linha manual não tem, então manter a manual deixaria o banco
//      reimportar a cobrança no próximo sync (duplicata de volta).
//   2. Apagar uma linha de OF a joga em `of_tx_ignoradas` (migration 113) — o
//      sync passa a IGNORAR aquela cobrança PARA SEMPRE. Descartar o lado do
//      banco apagaria do histórico uma cobrança real e definitiva.
//
// Por isso o lado descartado é SEMPRE a previsão manual, que é `pago=false` e
// sem `of_tx_id`: apagá-la não mexe em saldo (nunca debitou) nem em
// `of_tx_ignoradas` (não veio do banco). A fusão, portanto, NÃO MOVE DINHEIRO.
//
// ── ⚠️ A FUSÃO NÃO INVENTA A PROVA ──────────────────────────────────────────
//
// `planoFusao` só diz QUEM fica e QUEM sai. Se o par é mesmo a mesma coisa é o
// `ehDuplicata` do Watson que decide, na rota — a MESMA prova que o painel usou
// pra mostrar o par. Aqui não há tolerância nova pra calibrar.
// =============================================================================

/**
 * Decide, entre duas transações, qual MANTER (a do banco) e qual DESCARTAR
 * (a previsão manual). Devolve `{ seguro:false, motivo }` quando o par não é
 * exatamente "previsão manual pendente × cobrança do banco" — e aí a rota
 * recusa, deixando o usuário usar o excluir normal.
 *
 * @param {{id,of_tx_id,pago}} a
 * @param {{id,of_tx_id,pago}} b
 */
/**
 * @param {object} opts
 * @param {boolean} opts.contaDoBanco  a carteira do lançamento manual é de Open
 *   Finance. ⚠️ É ISTO que autoriza fundir um manual JÁ PAGO: em conta do banco
 *   o saldo vem do banco (regra de ouro), então apagar a cópia manual não mexe
 *   em saldo nenhum. Em conta manual o pago já debitou — apagar estornaria, e a
 *   fusão continua recusando. Medido em 17/10/2026: 39 duplicatas "manual pago ×
 *   banco" em 11 contas (R$ 22,3 mil a mais), todas em conta conectada.
 */
function planoFusao(a, b, { contaDoBanco = false } = {}) {
  if (!a || !b || !a.id || !b.id) return { seguro: false, motivo: 'faltam as duas transações' };
  // ⚠️ Guarda DEFENSIVA (equivalente no eval, de propósito): as guardas
  // estruturais abaixo já impedem a mesma linha de ser os dois lados — uma linha
  // não pode ter of_tx_id E não ter ao mesmo tempo — e a rota recusa antes
  // quando os dois ids são iguais (`.in` traz 1 só → length !== 2). Fica como
  // defesa em profundidade, não como regra testável isolada.
  if (a.id === b.id) return { seguro: false, motivo: 'é a mesma transação' };

  // O lado do banco: tem of_tx_id. O lado manual: sem of_tx_id E pendente —
  // ou JÁ PAGO, se a conta for do banco (ver `contaDoBanco` acima).
  const doBanco  = (t) => !!t.of_tx_id;
  const previsto = (t) => !t.of_tx_id && (t.pago === false || (contaDoBanco && t.pago === true));

  const banco = [a, b].find(doBanco);
  const prev  = [a, b].find(previsto);

  // Precisa de EXATAMENTE um de cada. Se os dois são do banco, ou os dois são
  // manuais, ou um é manual mas já pago, não é o caso que a fusão trata —
  // mexer em saldo/of_tx_ignoradas aqui seria arriscado, então recusa.
  if (!banco || !prev) return { seguro: false, motivo: 'a fusão só junta uma previsão manual pendente com a cobrança do banco' };
  if (banco.id === prev.id) return { seguro: false, motivo: 'não dá pra classificar os dois lados' };

  return { seguro: true, manterId: banco.id, descartarId: prev.id, banco, previsto: prev };
}

/**
 * O que a linha mantida (do banco) deve herdar da previsão descartada, quando o
 * usuário pede pra "manter meu nome". Só rótulo — nunca valor/data/pago, que
 * são a verdade do banco. Devolve `{}` quando não há o que herdar.
 */
function rotuloHerdado(previsto) {
  if (!previsto) return {};
  const out = {};
  const obs = (previsto.observacao || '').trim();
  const cat = (previsto.categoria || '').trim();
  if (obs) out.observacao = obs;
  if (cat) out.categoria = cat;
  // ⚠️ O VÍNCULO COM A CONTA FIXA vai junto. Linha "[Recorrente]" carrega
  // `recorrencia_id` + `competencia` — é por eles que `resolvidasNoMes` sabe
  // que a conta do mês foi paga. Apagar a cópia sem passá-los pra linha do
  // banco faria a conta fixa "esquecer" que foi paga (medido: 9 das 42
  // duplicatas conciliáveis eram linhas "[Recorrente]").
  if (previsto.recorrencia_id) out.recorrencia_id = previsto.recorrencia_id;
  if (previsto.recorrencia_id && previsto.competencia) out.competencia = previsto.competencia;
  return out;
}

// =============================================================================
// ABSORÇÃO AUTOMÁTICA no sync — escolher QUAIS pares juntar sozinho.
//
// Quando o banco traz uma cobrança que é, com PROVA, a mesma de uma previsão
// manual pendente (o `ehDuplicata` do Watson dizendo 'manual-e-banco'), a
// cobrança assume a previsão em vez de virar linha nova — o duplicado nunca
// aparece. É o que a conta/receita FIXA já faz; aqui estende pro previsto
// digitado à mão.
//
// ⚠️ SÓ JUNTA SOZINHO O QUE NÃO TEM AMBIGUIDADE NENHUMA. A regra é dos DOIS
// lados:
//   · a cobrança do banco pode casar com UMA só previsão (senão qual delas?);
//   · a previsão pode ser reivindicada por UMA só cobrança (senão qual paga?).
// Qualquer disputa → fica de FORA do automático e segue como sugestão do Watson
// (o usuário decide). Juntar errado aqui sumiria com uma previsão que a pessoa
// acompanhava — e o automático não pode ter o luxo da dúvida.
// =============================================================================

/**
 * Decide os pares (previsão manual × cobrança do banco) que podem ser juntados
 * SOZINHOS, sem ambiguidade dos dois lados.
 *
 * @param previsoes  previsões manuais pendentes [{ id, ... }]
 * @param cobrancas  cobranças do banco a inserir [{ of_tx_id, ... }]
 * @param saoMesma   (previsao, cobranca) => boolean — a PROVA (ehDuplicata)
 * @returns [{ previsao, cobranca }]  só os pares 1-pra-1 inequívocos
 */
function escolherAbsorcoes(previsoes, cobrancas, saoMesma) {
  const prevs = (previsoes || []).filter((p) => p && p.id);
  const cobs  = (cobrancas || []).filter((c) => c && c.of_tx_id);
  if (!prevs.length || !cobs.length) return [];

  // Pra cada cobrança, quais previsões casam. E, no caminho, quantas cobranças
  // disputam cada previsão (pra barrar o outro lado da ambiguidade).
  const casamentosPorCobranca = new Map();     // índice da cobrança -> [previsões]
  const cobrancasPorPrevisao  = new Map();      // id da previsão -> nº de cobranças que a querem

  cobs.forEach((c, ci) => {
    const casam = prevs.filter((p) => {
      try { return !!saoMesma(p, c); } catch { return false; }
    });
    casamentosPorCobranca.set(ci, casam);
    for (const p of casam) cobrancasPorPrevisao.set(p.id, (cobrancasPorPrevisao.get(p.id) || 0) + 1);
  });

  const pares = [];
  const previsoesUsadas = new Set();
  cobs.forEach((c, ci) => {
    const casam = casamentosPorCobranca.get(ci) || [];
    // A cobrança tem de casar com EXATAMENTE uma previsão.
    if (casam.length !== 1) return;
    const p = casam[0];
    // E essa previsão não pode ser disputada por outra cobrança.
    if ((cobrancasPorPrevisao.get(p.id) || 0) !== 1) return;
    // ⚠️ Guarda DEFENSIVA (equivalente no eval): a disputa acima já garante que
    // uma previsão casada por mais de uma cobrança é pulada de vez, então ela
    // nunca chega aqui usada duas vezes. Fica como defesa em profundidade.
    if (previsoesUsadas.has(p.id)) return;
    previsoesUsadas.add(p.id);
    pares.push({ previsao: p, cobranca: c });
  });
  return pares;
}

// =============================================================================
// CONCILIAR NA TELA — o par que o painel oferece ao lado do previsto.
//
// Relato (Vander, out/2026): previsto "Fatura Cartão BTG" R$ 2.911,60 e, no
// mesmo dia, "CardBankslip" R$ 2.911,60 do banco — os dois na lista, e a única
// saída era achar o Watson. O botão "Conciliar com o banco" aparece NA LINHA,
// mas SÓ quando existe a cobrança igual — e "igual" aqui é exatamente a régua
// do automático: a prova do Watson + par 1-pra-1 sem disputa dos dois lados.
//
// ⚠️ Mesma régua de propósito. Uma régua mais frouxa na tela ofereceria juntar
// coisa que o automático recusa por ambiguidade — e o usuário tocaria
// "conciliar" confiando que a Sora conferiu. Disputa continua com o Watson,
// que mostra o grupo inteiro e deixa a pessoa escolher.
//
// Também pega o caso que o automático NUNCA alcança: previsto digitado DEPOIS
// de a cobrança já ter chegado (medido em 15/10: 2 dos 4 pares presos da base).
// =============================================================================

/**
 * Pares (previsto manual pendente × cobrança do banco) conciliáveis numa lista
 * de transações já lidas do banco.
 *
 * @param transacoes  linhas do grupo (previstos e cobranças misturados)
 * @param saoMesma    (previsto, cobranca) => boolean — a PROVA (ehDuplicata)
 * @returns [{ previsto, banco }]
 */
function paresConciliaveis(transacoes, saoMesma, { contasDoBanco = new Set() } = {}) {
  const lista = (transacoes || []).filter((t) => t && t.id);
  // Previsto: o mesmo lado que `planoFusao` aceita descartar — sem of_tx_id E
  // pendente, OU já pago numa conta do banco (`contasDoBanco` = Set de
  // "grupo_id|carteira_nome" de carteiras com of_conta_id; ver `planoFusao`).
  // Recorrência fica de fora: ela tem a reconciliação própria.
  const daContaDoBanco = (t) => contasDoBanco.has(`${t.grupo_id}|${t.carteira_nome}`);
  // ⚠️ `!t.recorrente` e o filtro de `of_tx_id` nas cobranças são REDUNDANTES
  // (equivalentes na mutação): `ehDuplicata` já recusa recorrência e
  // `escolherAbsorcoes` já descarta cobrança sem of_tx_id. Ficam pra a lista
  // dizer por si o que é cada lado, sem depender de ler as outras duas funções.
  const previstos = lista.filter((t) => !t.of_tx_id && !t.recorrente
    && (t.pago === false || (t.pago === true && daContaDoBanco(t))));
  const cobrancas = lista.filter((t) => !!t.of_tx_id);
  return escolherAbsorcoes(previstos, cobrancas, saoMesma)
    .map(({ previsao, cobranca }) => ({ previsto: previsao, banco: cobranca }));
}

module.exports = { planoFusao, rotuloHerdado, escolherAbsorcoes, paresConciliaveis };
