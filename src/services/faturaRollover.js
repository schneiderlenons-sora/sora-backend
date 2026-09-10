// =============================================================================
// faturaRollover — pagamento parcial da fatura + rollover do saldo (SEM juros).
//
// Modelo (cartão MANUAL; Open Finance fica de fora — traz a fatura do banco):
//   • fatura(comp)   = soma ASSINADA do cartão no CICLO daquela competência
//                      (compra soma, estorno/crédito ABATE, pagamento é
//                       neutro — ver services/valorFatura.js)
//   • pago(comp)     = soma de pagamentos_fatura do cartão naquela competência
//   • restante(comp) = max(0, fatura − pago)
//
// ⚠️ O período é o CICLO REAL de fechamento (services/cicloFatura.js), não o
// mês-calendário: uma compra em 30/07 e outra em 01/08 caem na MESMA fatura
// quando o cartão fecha dia 5. `competencia` = 'YYYY-MM' do VENCIMENTO.
// Cartão sem dia_fechamento cai no mês-calendário (comportamento legado).
//
// Rollover: no vencimento, se restante > 0, abre fatura_rollover 'aguardando'
// (24h pra confirmar no WhatsApp). Confirmou OU passou 24h → materializa: cria
// um Gasto "Fatura anterior" no cartão no INÍCIO do ciclo seguinte, com o valor
// que sobrou. É marcado `transferencia:true` → entra na SOMA da fatura (que
// filtra por tipo 'Gasto') mas fica FORA dos relatórios de gasto (a compra
// original já contou no mês dela). SEM juros (decisão de produto).
// =============================================================================
const supabase = require('../db/supabase');
const { cicloPorCompetencia, competenciaVizinha, dataDaFatura, hojeSP } = require('./cicloFatura');
const { somarFatura } = require('./valorFatura');

const TZ = 'America/Sao_Paulo';

function ymHoje() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 7);
}
function mesSeguinte(ym) {
  const [y, m] = ym.split('-').map(Number);   // m é 1-based; new Date(y, m, 1) = mês seguinte
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Soma a fatura do cartão dentro de um intervalo [ini, fimExcl) — o ciclo.
//
// A soma é ASSINADA (services/valorFatura.js): compra soma, estorno/cashback
// ABATE, pagamento de fatura é neutro (já entra por `pagamentos_fatura`).
// Antes filtrava `tipo='Gasto'` no SQL e todo crédito era descartado.
//
// NÃO filtra `transferencia` no lado do Gasto: de propósito, pra o "Fatura
// anterior" (rollover) entrar na soma da fatura seguinte.
//
// ⚠️ QUEM DECIDE A FATURA É `dataDaFatura`, NÃO O CAMPO `data`. O banco agrupa
// pela data em que ELE lançou a compra (`bill_post_date`), então uma compra do
// DIA DO FECHAMENTO processada no dia seguinte pertence à fatura nova. Ver o
// helper em `cicloFatura.js` — inclusive as duas guardas contra arrastar
// parcela redistribuída.
//
// ⚠️ POR ISSO A JANELA DA QUERY É MAIOR QUE O CICLO. Filtrar no SQL por
// `data` entre `ini` e `fimExcl` nunca leria a linha de 07/08 que o banco
// lançou em 08/08 — ela ficaria de fora antes de a regra ser aplicada. Os 8
// dias de folga cobrem com sobra o teto de 7 do helper.
// ⚠️ `of_bill_post_date` VAZIO NUM CICLO QUE JÁ FOI FATURADO SIGNIFICA "NÃO
// ENTROU NESTA FATURA" — e é essa leitura que faltava.
//
// `dataDaFatura` usa o `bill_post_date` quando ele EXISTE. Mas o emissor só o
// preenche na linha que ele já lançou numa fatura; a compra que ficou pra
// próxima vem com o campo VAZIO, e aí o helper cai na data da compra — que,
// sendo do dia do fechamento, devolve a linha justamente pra fatura de onde o
// banco a tirou.
//
// RELATO (set/2026, cartão do dono): banco R$ 472,66, painel R$ 4.091,58.
// Medido no cartão, na virada do ciclo que fechou em 08/09:
//
//   03/09 FACEBK 117,60 ... post_date 2026-09-08  → entrou na fatura de set
//   05/09 GOOGLE 132,74 ... post_date 2026-09-08  → entrou
//   07/09 ELÓI     5,49 ... post_date 2026-09-08  → entrou
//   08/09 IFOOD   41,14 ... post_date VAZIO       → o banco jogou pra outubro
//   08/09 APPLE    5,00 ... post_date VAZIO       → idem
//
// Sem estas duas, setembro soma 4.018,54 — EXATAMENTE o que foi pago
// (2.854,70 + 1.163,84) — e outubro fica 426,52 + 46,14 = **472,66**, o
// número que o app do banco mostra. Ao centavo, dos dois lados.
//
// ⚠️ A REGRA SÓ VALE ONDE HÁ REFERÊNCIA. Se NENHUMA linha do trecho tem
// post_date, não dá pra afirmar nada (é o caso da maioria do histórico, e de
// todo ciclo ainda ABERTO, que o emissor não faturou) — e aí nada muda. Isso é
// o que mantém a mudança inerte fora da borda: medido nas 502 competências com
// fatura publicada, só 2 linhas se movem, 1 competência fica mais perto do
// banco e NENHUMA piora.
//
// ⚠️ E o corte é `>= maiorPost`, não "sem post_date". Linha antiga sem o campo
// (o histórico anterior à coleta) fica onde está — só a que é POSTERIOR ao
// último lançamento conhecido do ciclo é candidata a ter ficado de fora.
// ⚠️ E VAZIO NEM SEMPRE QUER DIZER "AINDA NÃO FATURADO" — ÀS VEZES É SÓ VELHO.
//
// O sync dedupa por `of_tx_id` e NUNCA reescreve linha existente (regra que
// protege a categoria corrigida à mão). Então o `bill_post_date` é gravado UMA
// VEZ, no import: a linha que chegou antes de o emissor faturá-la fica com o
// campo vazio PARA SEMPRE, mesmo depois de ser cobrada.
//
// Medido no mesmo cartão, um mês antes: APPLE.COM/BILL de 08/08 (dia do
// fechamento) também está com o campo vazio. Sem esta guarda ela seria
// "empurrada" pra setembro e a fatura fecharia R$ 5,00 acima do banco.
//
// O que separa os dois casos é o RELÓGIO DO EMISSOR, não o nosso: se já existe
// lançamento posterior à linha por mais de meio ciclo, o emissor evidentemente
// já faturou aquele período — o vazio dela é resíduo do import, não informação.
// Na linha de 08/09 o lançamento mais recente conhecido é 08/09, então o vazio
// ainda significa "não faturada". Na de 08/08, o mais recente é 08/09 — um mês
// depois —, então ela já foi cobrada e fica onde está.
const MEIO_CICLO_DIAS = 20;

function separarEmpurradas(linhas, ini, fimExcl, ultimoPostConhecido) {
  const doTrecho = (linhas || []).filter((t) => {
    const d = dataDaFatura(t);
    return d >= ini && d < fimExcl;
  });
  const posts = doTrecho
    .map((t) => (t.of_bill_post_date ? String(t.of_bill_post_date).slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  const maiorPost = posts[posts.length - 1];
  if (!maiorPost) return { fica: doTrecho, sai: [] };

  const fica = [], sai = [];
  for (const t of doTrecho) {
    const dia = String(t.data).slice(0, 10);
    const semPost = !t.of_bill_post_date;
    // Vazio obsoleto: o emissor já faturou período MUITO posterior a esta
    // linha, logo ela não está "esperando" fatura nenhuma.
    const vazioVelho = semPost && ultimoPostConhecido &&
      (new Date(ultimoPostConhecido) - new Date(dia)) / 86400000 > MEIO_CICLO_DIAS;

    if (semPost && !vazioVelho && dia >= maiorPost) sai.push(t);
    else fica.push(t);
  }
  return { fica, sai };
}

async function somaFaturaCiclo(grupoId, cartaoNome, ciclo, cicloAnterior) {
  const folga = (dia, n) => {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // ⚠️ HERDA DO CICLO ANTERIOR DE VERDADE, NUNCA DE "35 DIAS ATRÁS".
  //
  // Primeira versão disto usava uma janela fixa pra trás, e ela ATRAVESSA dois
  // ciclos: num cartão a fatura de novembro herdou o mês de outubro INTEIRO e
  // dobrou (R$ 1.340,85 → R$ 2.681,70). O trecho de origem tem de ser
  // exatamente [anterior.ini, anterior.fimExcl).
  //
  // ⚠️ E SÓ CICLO JÁ FECHADO EMPURRA. Ciclo aberto não foi faturado por
  // ninguém, então não tem como ter deixado nada de fora — era o que fazia
  // fatura FUTURA ganhar valor do nada (três cartões, R$ 67,11 e R$ 254,29).
  const anterior = cicloAnterior && cicloAnterior.ini && cicloAnterior.fimExcl <= ciclo.ini
    && cicloAnterior.fim < hojeSP()
    ? cicloAnterior
    : null;
  const inicioBusca = anterior ? anterior.ini : ciclo.ini;
  // ⚠️ A JANELA ABRE 35 DIAS ANTES, não 8. Além da folga do `dataDaFatura`,
  // ela precisa alcançar o CICLO ANTERIOR INTEIRO — é lá que se descobre qual
  // foi o último lançamento dele e, portanto, o que ele empurrou pra cá. Com
  // só 8 dias, o `maiorPost` do trecho anterior sairia de um pedaço do ciclo e
  // poderia não existir.
  // ⚠️ AS DUAS CONSULTAS SAEM JUNTAS (`Promise.all`). Render (Oregon) e
  // Supabase (Ohio) — o custo aqui é a TRAVESSIA, não a query; em série isso
  // seriam duas idas pra cada fatura calculada.
  const [{ data }, { data: ult }] = await Promise.all([
    supabase.from('transacoes')
      .select('valor, tipo, categoria, transferencia, data, of_bill_post_date, parcela_num')
      .eq('grupo_id', grupoId).ilike('carteira_nome', cartaoNome)
      .gte('data', folga(inicioBusca, -8)).lt('data', folga(ciclo.fimExcl, 8)),
    // ⚠️ O RELÓGIO DO EMISSOR É DO CARTÃO, NUNCA DA JANELA — e essa distinção
    // é o que impede uma linha de SUMIR das duas faturas.
    //
    // Tirando o `ultimoPost` da janela deslizante, agosto e setembro
    // enxergavam relógios diferentes para a MESMA linha: no cálculo de agosto
    // (janela até 16/08) ela parecia "ainda não faturada" e era empurrada pra
    // frente; no de setembro (janela até 17/09, já com lançamento de 08/09) ela
    // parecia "vazio velho" e não era herdada. Resultado: R$ 5,00 saíam de
    // agosto e não entravam em setembro — dinheiro evaporando entre faturas.
    supabase.from('transacoes')
      .select('of_bill_post_date')
      .eq('grupo_id', grupoId).ilike('carteira_nome', cartaoNome)
      .not('of_bill_post_date', 'is', null)
      .order('of_bill_post_date', { ascending: false }).limit(1),
  ]);

  const ultimoPost = ult && ult[0] && ult[0].of_bill_post_date
    ? String(ult[0].of_bill_post_date).slice(0, 10)
    : null;

  // O que é deste ciclo, menos o que o emissor empurrou pra frente…
  const { fica } = separarEmpurradas(data, ciclo.ini, ciclo.fimExcl, ultimoPost);
  // …mais o que o ciclo ANTERIOR empurrou pra cá. As duas metades usam a MESMA
  // função e o MESMO `ultimoPost` de propósito: o que sai de um lado tem de
  // entrar do outro, senão a linha desaparece das duas faturas.
  const { sai: herdadas } = anterior
    ? separarEmpurradas(data, anterior.ini, anterior.fimExcl, ultimoPost)
    : { sai: [] };

  return somarFatura([...fica, ...herdadas]);
}

async function pagoDaFatura(cartaoId, ym) {
  const { data, error } = await supabase.from('pagamentos_fatura')
    .select('valor').eq('cartao_id', cartaoId).eq('competencia', ym);
  if (error) return 0; // tolerante à migration 096
  return (data || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Status da fatura de uma competência. `cartao` precisa de { id, nome,
// dia_fechamento, dia_vencimento } — o ciclo sai daí. Devolve o `ciclo` junto
// pra quem chama poder exibir o período sem recalcular.
async function statusFatura(grupoId, cartao, ym) {
  const ciclo = cicloPorCompetencia(cartao, ym);
  // O ciclo anterior entra porque o emissor pode ter empurrado linhas DELE pra
  // esta fatura (ver `somaFaturaCiclo`). Tolerante: se a vizinhança falhar, a
  // soma segue valendo sem a herança, que é o comportamento de antes.
  let anterior = null;
  try {
    anterior = cicloPorCompetencia(cartao, competenciaVizinha(cartao, ym, -1));
  } catch { anterior = null; }
  const fatura = cent(await somaFaturaCiclo(grupoId, cartao.nome, ciclo, anterior));
  const pago = cent(await pagoDaFatura(cartao.id, ym));
  const restante = Math.max(0, cent(fatura - pago));
  return { fatura, pago, restante, ciclo };
}

// Cria o lançamento "Fatura anterior" na fatura SEGUINTE e marca o rollover
// rolado. A data é o INÍCIO do ciclo seguinte (antes era o dia 1 do mês, que
// com ciclo real podia cair na fatura errada).
async function materializarRollover(row, cartaoNome, cartao) {
  const compAlvo = cartao?.dia_fechamento
    ? competenciaVizinha(cartao, row.competencia, 1)
    : mesSeguinte(row.competencia);
  const cicloAlvo = cicloPorCompetencia(
    cartao || { dia_vencimento: null }, compAlvo,
  );
  const idCurto = Math.random().toString(36).substring(2, 8).toUpperCase();
  const base = {
    id_curto:      idCurto,
    grupo_id:      row.grupo_id,
    criado_por:    row.user_id || null,
    tipo:          'Gasto',
    categoria:     'Fatura anterior',
    valor:         Number(row.valor),
    observacao:    `Saldo não pago da fatura ${row.competencia}`,
    carteira_nome: cartaoNome,
    pago:          true,
    data:          `${cicloAlvo.ini}T12:00:00.000Z`,
  };
  // transferencia:true → soma na fatura (filtro por tipo 'Gasto') mas fora dos
  // relatórios de gasto. Tolerante se a coluna 046 não existir.
  let { data: tx, error } = await supabase.from('transacoes')
    .insert({ ...base, transferencia: true }).select('id').single();
  if (error && /transferencia/i.test(error.message || '')) {
    ({ data: tx, error } = await supabase.from('transacoes').insert(base).select('id').single());
  }
  if (error) throw error;

  await supabase.from('fatura_rollover').update({
    status: 'rolado', rolado_em: new Date().toISOString(),
    transacao_rollover_id: tx?.id || null,
  }).eq('id', row.id);
  return tx;
}

module.exports = { TZ, ymHoje, mesSeguinte, somaFaturaCiclo, pagoDaFatura, statusFatura, materializarRollover, cent };

// =============================================================================
// PAGAMENTO DE FATURA VINDO DO OPEN FINANCE
//
// BUG QUE ISTO CORRIGE: o sync já importava o pagamento da fatura como
// transação (`Recebimento` + `transferencia`, categoria Fatura) — medido numa
// conta real: R$ 2.243,60 em 03/08 e R$ 565,68 em 09/08. Mas NADA disso chegava
// em `pagamentos_fatura`, que é a tabela que o `statusFatura` consulta pra
// calcular `restante = fatura − pago`. Resultado: `pago = 0` pra sempre, a
// fatura nunca ficava quitada e o painel continuava parado nela.
// =============================================================================

/**
 * Competência que um pagamento feito em `dataPg` quitou.
 *
 * É a fatura de vencimento MAIS PRÓXIMO da data do pagamento — a mesma ideia de
 * `vencimentoCoberto` em services/vencimentoDivida.js. Pagar dia 09 uma fatura
 * que vence dia 13 é "pagou a de agosto" (adiantado); pagar dia 20 é "pagou a
 * de agosto atrasado", não a de setembro. Escolher sempre a próxima a vencer
 * jogaria todo pagamento atrasado pra fatura errada.
 */
function competenciaDoPagamento(cartao, dataPg) {
  const { competenciaAtual, competenciaVizinha } = require('./cicloFatura');
  // Sem dia de vencimento o ciclo cai no mês-calendário (legado) e o "mais
  // próximo" passa a comparar com o ÚLTIMO DIA do mês — pagar 09/08 daria a
  // competência de julho. Melhor não gravar do que gravar na fatura errada.
  if (!cartao || !cartao.dia_vencimento) return null;
  const dia = String(dataPg).slice(0, 10);
  const proxima = competenciaAtual(cartao, dia);
  if (!proxima) return null;
  const anterior = competenciaVizinha(cartao, proxima, -1);

  const dist = (comp) => {
    const c = cicloPorCompetencia(cartao, comp);
    if (!c || !c.venc) return Infinity;
    return Math.abs(Date.parse(`${c.venc}T12:00:00Z`) - Date.parse(`${dia}T12:00:00Z`));
  };
  return dist(anterior) < dist(proxima) ? anterior : proxima;
}

/** Pagamentos registrados numa competência (valor + data), do mais novo. */
async function pagamentosDaFatura(cartaoId, competencia) {
  try {
    const { data, error } = await supabase.from('pagamentos_fatura')
      .select('valor, data').eq('cartao_id', cartaoId).eq('competencia', competencia)
      .order('data', { ascending: false });
    return error ? [] : (data || []);
  } catch { return []; }
}

/**
 * A fatura foi PAGA depois de fechar?
 *
 * É a regra que o usuário pediu, literal: só se pode dar a fatura por encerrada
 * (e passar pra seguinte) quando existe pagamento DEPOIS da data de fechamento
 * que cobre o valor dela. Pagamento feito ANTES do fechamento não conta: no
 * Mercado Pago é comum abater a fatura em curso aos poucos (medido nesta conta:
 * R$ 2.243,60 no dia 03, com a fatura fechando dia 08) — e ela continua aberta
 * até fechar e ser quitada.
 *
 * ⚠️ No cartão de Open Finance, o valor da fatura já vem LÍQUIDO de pagamentos
 * (o `simulated_bill_total_amount` desconta os abatimentos do ciclo). Por isso
 * comparamos só com o que entrou DEPOIS do fechamento — descontar tudo de novo
 * zeraria fatura que ainda está de pé.
 */
function quitadaDepoisDoFechamento(pagamentos, fatura, ciclo) {
  if (!(Number(fatura) > 0.01) || !ciclo?.fim) return false;
  const depois = (pagamentos || [])
    .filter((p) => String(p.data).slice(0, 10) > ciclo.fim)
    .reduce((s, p) => s + (Number(p.valor) || 0), 0);
  return cent(depois) >= cent(fatura) - 0.01;
}

/**
 * Registra em `pagamentos_fatura` os pagamentos que o Open Finance trouxe.
 *
 * Idempotente por `transacao_id` — o sync roda todo dia e não pode empilhar o
 * mesmo pagamento. Tolerante de ponta a ponta: nada aqui derruba o sync.
 *
 * @returns {Promise<number>} quantos pagamentos NOVOS foram registrados
 */
async function registrarPagamentosDoOF(grupoId, cartao) {
  try {
    if (!grupoId || !cartao?.id || !cartao?.nome) return 0;
    // ⚠️ `ehPagamentoFaturaCat` (valorFatura.js), NÃO o `ehPagamentoFatura` do
    // catálogo: aquele compara a string EXATA e devolve false pra '💳 Fatura'.
    const { ehPagamentoFaturaCat } = require('./valorFatura');

    // Só o que veio do banco (`of_tx_id`) e é reconhecidamente pagamento de
    // fatura. Lançamento manual continua entrando pelo fluxo do painel.
    const { data: pgs } = await supabase.from('transacoes')
      .select('id, valor, data, categoria, transferencia, of_tx_id')
      .eq('grupo_id', grupoId).ilike('carteira_nome', cartao.nome)
      .eq('tipo', 'Recebimento').not('of_tx_id', 'is', null)
      .order('data', { ascending: false }).limit(200);
    const candidatos = (pgs || []).filter(
      (t) => t.transferencia === true && ehPagamentoFaturaCat(t.categoria) && Number(t.valor) > 0);
    if (!candidatos.length) return 0;

    // Quais já foram registrados (chave: transacao_id).
    const { data: jaTem } = await supabase.from('pagamentos_fatura')
      .select('transacao_id').eq('cartao_id', cartao.id)
      .in('transacao_id', candidatos.map((t) => t.id));
    const registrados = new Set((jaTem || []).map((p) => p.transacao_id));

    const novos = [];
    for (const t of candidatos) {
      if (registrados.has(t.id)) continue;
      const competencia = competenciaDoPagamento(cartao, t.data);
      if (!competencia) continue;
      novos.push({
        grupo_id: grupoId, cartao_id: cartao.id, competencia,
        valor: cent(t.valor), data: String(t.data).slice(0, 10), transacao_id: t.id,
      });
    }
    if (!novos.length) return 0;

    const { error } = await supabase.from('pagamentos_fatura').insert(novos);
    if (error) return 0;                     // migration 096 pendente, p.ex.
    return novos.length;
  } catch { return 0; }
}

module.exports.competenciaDoPagamento = competenciaDoPagamento;
module.exports.registrarPagamentosDoOF = registrarPagamentosDoOF;
module.exports.pagamentosDaFatura = pagamentosDaFatura;
module.exports.quitadaDepoisDoFechamento = quitadaDepoisDoFechamento;
// Exposto pra eval: a regra de "o emissor empurrou esta linha pra fatura seguinte".
module.exports.separarEmpurradas = separarEmpurradas;
