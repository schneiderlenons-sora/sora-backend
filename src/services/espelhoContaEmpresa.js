// =============================================================================
// CONTA DO BANCO → CAIXA DA EMPRESA (Sora Negócios, migration 189).
//
// Pedido (Robert, out/2026): "uso a conta PJ todos os dias, faço conciliação
// bancária e toda a operação da empresa" — e o Open Finance só alimentava as
// finanças PESSOAIS. Aqui a conta do banco é VINCULADA a uma conta da empresa
// (`contas_negocio.wallet_id`) e as movimentações dela passam a entrar no caixa
// (`lancamentos_negocio`), cada uma ligada à transação de origem.
//
// Decisões do dono (29/10/2026): conta INTEIRA (não transação a transação);
// em 2 passos (este é o A: o pessoal continua igual); categoria NEUTRA que a
// pessoa classifica.
//
// O que a simulação só-leitura na base mostrou e virou regra aqui:
//   · 1 cliente já digitava o caixa à mão: 8 lançamentos sairiam EM DOBRO.
//     → o que já foi digitado (mesmo sentido, mesmo valor no centavo, até 3
//       dias) é JUNTADO ao do banco, nunca duplicado — a categoria dele fica.
//   · as categorias do banco ("Pix", "Transferências", "Outros") não servem
//     pra empresa → entram como 'a_classificar'.
//   · 227 saídas eram APLICAÇÃO automática e dezenas eram transferência entre
//     contas próprias → 'movimentacao', que mexe no SALDO da conta mas NÃO é
//     receita nem despesa (fora do DRE e dos totais — `ehMovimentacao`).
//
// ⚠️ O BANCO É A VERDADE DO VALOR, A PESSOA É A VERDADE DA CATEGORIA. Se o
// banco corrigir valor/data, o lançamento acompanha; a categoria que a pessoa
// deu nunca é sobrescrita.
// ⚠️ IMPORTA A PARTIR DE `importar_desde` (1º dia do mês do vínculo): trazer
// meses fechados reescreveria DRE que o dono já usou pra decidir.
// =============================================================================

const TZ = 'America/Sao_Paulo';

/** Categorias especiais do caixa que vêm do banco. */
const CAT_A_CLASSIFICAR = 'a_classificar';
const CAT_MOVIMENTACAO = 'movimentacao';

/** Lançamento que só move dinheiro entre contas: fora de receita/despesa/DRE. */
function ehMovimentacao(l) {
  return !!l && l.categoria === CAT_MOVIMENTACAO;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// Categorias PESSOAIS que, numa conta de empresa, são só dinheiro mudando de
// lugar. "Rendimentos" NÃO entra: juro de aplicação é receita de verdade.
const CATS_MOVIMENTO = new Set([
  'transferencias', 'transferencia', 'transferencia recebida', 'transferencia enviada',
  'investimentos', 'investimento', 'aplicacao', 'aplicacoes', 'resgate', 'resgates',
  'fatura', 'pagamento de fatura', 'cartao de credito', 'ajuste', 'ajuste recebido',
]);

/** A transação do banco, na conta da empresa, é só movimentação? */
function transacaoEhMovimento(t) {
  if (!t) return false;
  if (t.transferencia === true) return true;
  return CATS_MOVIMENTO.has(norm(t.categoria));
}

/**
 * Dia (YYYY-MM-DD) da transação no fuso de SP.
 * ⚠️ `transacoes.data` guarda DUAS coisas (ver lib/data-br.ts no front): data
 * pura gravada como meia-noite UTC → é aquele dia; instante real → converte pra
 * SP (às 01h UTC ainda é o dia anterior no Brasil).
 */
function diaSP(v) {
  const s = String(v || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|\+00(:?00)?)$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

const centavos = (v) => Math.round(Number(v || 0) * 100);
/** Até quantos dias do VENCIMENTO o banco dá baixa numa conta em aberto.
 *  Menos de uma semana: com parcelas semanais de mesmo valor, mais que isso
 *  deixaria um pagamento atrasado quitar a parcela da semana seguinte. */
const DIAS_VENCIMENTO = 6;
const tipoDe = (t) => (t.tipo === 'Recebimento' ? 'entrada' : 'saida');
const diasEntre = (a, b) => Math.abs((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);

/** O lançamento que a transação vira (sem id). */
function lancamentoDaTransacao(t, { empresaId, contaId, userId, regras = [] }) {
  const tipo = tipoDe(t);
  const descricao = String(t.observacao || t.categoria || 'Movimentação do banco').trim().slice(0, 200) || 'Movimentação do banco';
  // Movimentação entre contas vence a regra; senão, o que a empresa já ensinou
  // ("aprende", migration 192); senão, neutra pra pessoa classificar.
  const categoria = transacaoEhMovimento(t)
    ? CAT_MOVIMENTACAO
    : (require('./regrasNegocio').categoriaPorRegra(regras, { descricao, tipo }) || CAT_A_CLASSIFICAR);
  return {
    empresa_id: empresaId,
    user_id: userId,
    conta_id: contaId,
    transacao_id: t.id,
    origem: 'banco',
    tipo,
    categoria,
    descricao,
    valor: Math.abs(centavos(t.valor)),
    data: diaSP(t.data),
    status: t.pago === false ? 'pendente' : 'pago',
    pago_em: t.pago === false ? null : diaSP(t.data),
    forma_pagamento: 'transferencia',
  };
}

/**
 * O PLANO de uma passada (puro, sem banco).
 *
 * @param {object} p
 * @param {Array}  p.transacoes  transações da conta do banco (id, tipo, valor, data, categoria, observacao, transferencia, pago)
 * @param {Array}  p.lancamentos lançamentos da EMPRESA (id, tipo, valor, data, categoria, transacao_id, origem, conta_id, forma_pagamento)
 * @param {string} p.desde       'YYYY-MM-DD' — nada antes disso entra
 * @param {string} p.contaId     conta da empresa vinculada
 * @param {string} p.empresaId
 * @param {string} p.userId      autor dos lançamentos novos
 * @returns {{ inserir: object[], juntar: {lancamentoId:string, transacaoId:string, patch:object}[],
 *             atualizar: {lancamentoId:string, patch:object}[] }}
 */
function planejarEspelho({ transacoes = [], lancamentos = [], desde, contaId, empresaId, userId, regras = [] }) {
  const inserir = [], juntar = [], atualizar = [];
  const ctx = { empresaId, contaId, userId, regras };

  // Só transação real do período, em real, com valor.
  const txs = transacoes
    .filter((t) => t && t.id && (t.tipo === 'Gasto' || t.tipo === 'Recebimento'))
    .filter((t) => Math.abs(centavos(t.valor)) > 0)
    .filter((t) => !desde || diaSP(t.data) >= desde)
    .sort((a, b) => diaSP(a.data).localeCompare(diaSP(b.data)) || String(a.id).localeCompare(String(b.id)));

  const porTx = new Map();
  for (const l of lancamentos) if (l.transacao_id) porTx.set(l.transacao_id, l);

  // Candidatos a JUNTAR, todos SEM transação ligada:
  //   · digitados à mão, desta conta ou sem conta, e que não foram em DINHEIRO
  //     (venda em dinheiro não passa pelo banco — casar R$ 50 em espécie com um
  //     Pix de R$ 50 seria inventar);
  //   · ⚠️ ÓRFÃOS do banco: o agregador às vezes REPROCESSA e regrava as
  //     transações com id novo (o dedup do sync apaga a cópia velha, e a FK
  //     solta o lançamento). Sem isto a transação nova entraria DE NOVO no
  //     caixa — e a categoria que a pessoa deu ficaria na cópia esquecida.
  const manuais = lancamentos
    .filter((l) => !l.transacao_id)
    .filter((l) => (l.origem === 'banco'
      ? l.conta_id === contaId
      : (!l.conta_id || l.conta_id === contaId) && l.forma_pagamento !== 'dinheiro'));
  const usados = new Set();

  for (const t of txs) {
    const ja = porTx.get(t.id);
    const alvo = lancamentoDaTransacao(t, ctx);

    if (ja) {
      // Já espelhada. O banco manda no valor/data/sentido/status; a categoria
      // e a descrição que a pessoa ajustou ficam.
      // ⚠️ No lançamento DIGITADO e juntado, só a situação acompanha o banco:
      // a `data` dele é a COMPETÊNCIA (o mês da mensalidade, no DRE) e não pode
      // virar a data do Pix — e o valor já casou no centavo.
      const chaves = ja.origem === 'banco'
        ? ['tipo', 'valor', 'data', 'status', 'pago_em']
        : ['status', 'pago_em'];
      const patch = {};
      for (const k of chaves) {
        if (String(ja[k] ?? '') !== String(alvo[k] ?? '')) patch[k] = alvo[k];
      }
      if (Object.keys(patch).length) atualizar.push({ lancamentoId: ja.id, patch });
      continue;
    }

    const casar = (l) => !usados.has(l.id) && l.tipo === alvo.tipo && Number(l.valor) === alvo.valor;
    const maisProximo = (lista, dataDe, max) => lista
      .map((l) => ({ l, d: diasEntre(String(dataDe(l)).slice(0, 10), alvo.data) }))
      .filter((c) => c.d <= max)
      .sort((a, b) => a.d - b.d || String(a.l.id).localeCompare(String(b.l.id)))[0];

    // 1) Já digitado como PAGO? Mesmo sentido, mesmo valor no centavo, até 3
    //    dias da data — o mais próximo. Pareamento 1:1: duas vendas de R$ 50
    //    digitadas casam com as DUAS do banco, nunca as duas com a mesma.
    // 2) CONTA EM ABERTO (a receber / a pagar)? Mesmo sentido e valor, até
    //    DIAS_VENCIMENTO do VENCIMENTO — é a baixa automática. Caso de origem
    //    (Robert): contrato fixo recebido toda semana, lançado como conta a
    //    receber; o Pix da semana tem de quitar AQUELA conta, não entrar ao
    //    lado dela como receita nova (a projeção ficaria dobrada). Com parcelas
    //    semanais de mesmo valor, o vencimento mais próximo decide qual — e a
    //    janela fica abaixo de uma semana pra não pular pra parcela seguinte.
    const pagos = manuais.filter((l) => l.status !== 'pendente' && casar(l));
    const abertos = manuais.filter((l) => l.status === 'pendente' && casar(l));
    // ⚠️ Em aberto, entre as de MESMO valor dentro da janela, quita a de
    // vencimento MAIS ANTIGO (a dívida mais velha primeiro). "A mais próxima"
    // erraria: Pix no dia 11 com parcelas vencendo 7 e 14 está mais perto da
    // do dia 14 — e deixaria a do dia 7 em aberto como se não tivesse sido paga.
    const vencDe = (l) => String(l.vencimento || l.data).slice(0, 10);
    const maisAntiga = abertos
      .filter((l) => diasEntre(vencDe(l), alvo.data) <= DIAS_VENCIMENTO)
      .sort((a, b) => vencDe(a).localeCompare(vencDe(b)) || String(a.id).localeCompare(String(b.id)))[0];
    const achado = maisProximo(pagos, (l) => l.data, 3) || (maisAntiga && { l: maisAntiga });
    if (achado) {
      usados.add(achado.l.id);
      juntar.push({ lancamentoId: achado.l.id, transacaoId: t.id, patch: { conta_id: contaId, status: alvo.status, pago_em: alvo.pago_em } });
      continue;
    }

    inserir.push(alvo);
  }

  return { inserir, juntar, atualizar };
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSO B — A CONTA DA EMPRESA SAI DAS FINANÇAS PESSOAIS (migration 192).
//
// Antes, o mesmo Pix era receita da empresa (no caixa) E receita da pessoa
// (no dashboard, relatórios, limites, resumos do WhatsApp). Cada transação que
// entra no caixa da empresa ganha `transacoes.ignorar_em = 'empresa'`.
//
// ⚠️ É O "NÃO CONSIDERAR" QUE TODO TOTAL PESSOAL JÁ RESPEITA (ehTransferencia
// no backend e em lib/ssr-data.ts, gráficos, categorias, limites — todos tratam
// qualquer valor em `ignorar_em` como fora). Uma alavanca só, em vez de ensinar
// cada tela a pular a carteira da empresa.
// ⚠️ VALOR PRÓPRIO ('empresa'), nunca 'tudo': desvincular tira EXATAMENTE o que
// foi posto aqui, sem desfazer o "não considerar" que a própria pessoa escolheu.
// ⚠️ SÓ MARCA O QUE ESTÁ SEM MARCA: a escolha da pessoa vence.
// ⚠️ SÓ NA HORA EM QUE A TRANSAÇÃO ENTRA NO CAIXA. Se a pessoa depois mandar
// "voltar a considerar" uma delas, o próximo sync não a marca de novo.
// ─────────────────────────────────────────────────────────────────────────────
const MARCA_EMPRESA = 'empresa';

/** Transações que esta passada ligou ao caixa (as que ganham a marca). */
function idsLigadosNaPassada(plano) {
  const ids = new Set();
  for (const l of (plano && plano.inserir) || []) if (l.transacao_id) ids.add(l.transacao_id);
  for (const j of (plano && plano.juntar) || []) if (j.transacaoId) ids.add(j.transacaoId);
  return [...ids];
}

/** Marca (ou desmarca) transações como "da empresa". Tolerante: falha é log. */
async function marcarEmpresa(ids, marcar, { supabase }) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const q = supabase.from('transacoes').update({ ignorar_em: marcar ? MARCA_EMPRESA : null }).in('id', lote);
    const { data, error } = await (marcar ? q.is('ignorar_em', null) : q.eq('ignorar_em', MARCA_EMPRESA)).select('id');
    if (error) { console.warn('[espelho/pessoal]', error.message); return n; }
    n += (data || []).length;
  }
  return n;
}

/**
 * Liga/desliga "esta conta é só da empresa" pra TUDO que a conta já trouxe.
 * Usado ao desvincular (desliga) e quando a pessoa muda a opção.
 * @returns {Promise<number>} quantas transações mudaram
 */
async function aplicarForaDoPessoal(contaNegocioId, ativo, { supabase = require('../db/supabase') } = {}) {
  const { data, error } = await supabase.from('lancamentos_negocio')
    .select('transacao_id').eq('conta_id', contaNegocioId).not('transacao_id', 'is', null);
  if (error || !data || !data.length) return 0;
  return marcarEmpresa([...new Set(data.map((l) => l.transacao_id))], !!ativo, { supabase });
}

/** 1º dia do mês corrente em SP — onde a importação começa ao vincular. */
function inicioDoMesSP(agora = new Date()) {
  return agora.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 8) + '01';
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUÇÃO (toca o banco). Idempotente: rodar duas vezes não muda nada na
// segunda, e o índice único em lancamentos_negocio.transacao_id (189) segura
// duas passadas simultâneas (sync por webhook + vínculo na mesma hora).
// ─────────────────────────────────────────────────────────────────────────────

const ehBRL = (m) => !m || String(m).toUpperCase() === 'BRL';
const ehCartao = (tipo) => /cr[eé]dito/i.test(String(tipo || ''));

/** A carteira pode ser vinculada a uma conta da empresa? (motivo legível se não) */
function motivoInelegivel(wallet) {
  if (!wallet) return 'Conta do banco não encontrada.';
  if (!wallet.of_conta_id) return 'Só contas conectadas pelo Open Finance podem ser vinculadas.';
  if (ehCartao(wallet.tipo)) return 'Por enquanto só conta corrente ou poupança (cartão de crédito ainda não).';
  if (!ehBRL(wallet.moeda)) return 'O Sora Negócios trabalha em real; esta conta é em outra moeda.';
  return null;
}

async function lerTudo(montar) {
  const PAG = 1000; const out = [];
  for (let de = 0; ; de += PAG) {
    const { data, error } = await montar().range(de, de + PAG - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAG) return out;
  }
}

/**
 * Espelha UMA conta da empresa vinculada a uma carteira do banco.
 * @returns {{ inseridos:number, juntados:number, atualizados:number, motivo?:string }}
 */
async function espelharConta(contaNegocioId, { supabase = require('../db/supabase') } = {}) {
  const COLS_CONTA = 'id, empresa_id, user_id, wallet_id, importar_desde, ativa';
  let { data: conta, error: eConta } = await supabase.from('contas_negocio')
    .select(COLS_CONTA + ', fora_do_pessoal').eq('id', contaNegocioId).maybeSingle();
  // Sem a migration 192: a coluna não existe e a conta NÃO sai do pessoal
  // (comportamento de antes) — nunca derrubar o espelho por isso.
  if (eConta && /fora_do_pessoal/i.test(eConta.message || '')) {
    ({ data: conta, error: eConta } = await supabase.from('contas_negocio')
      .select(COLS_CONTA).eq('id', contaNegocioId).maybeSingle());
    if (conta) conta.fora_do_pessoal = false;
  }
  if (eConta) throw eConta;
  if (!conta || !conta.ativa || !conta.wallet_id) return { inseridos: 0, juntados: 0, atualizados: 0, motivo: 'sem vínculo' };

  const { data: wallet } = await supabase.from('wallets')
    .select('id, grupo_id, nome, tipo, moeda, of_conta_id').eq('id', conta.wallet_id).maybeSingle();
  const motivo = motivoInelegivel(wallet);
  if (motivo) return { inseridos: 0, juntados: 0, atualizados: 0, motivo };

  const desde = conta.importar_desde || inicioDoMesSP();
  // 5 dias antes: o lançamento digitado à mão pode estar até 3 dias antes da
  // transação, e a data da transação vem em UTC.
  const desdeLanc = new Date(Date.parse(desde + 'T12:00:00Z') - 5 * 864e5).toISOString().slice(0, 10);

  const transacoes = await lerTudo(() => supabase.from('transacoes')
    .select('id, tipo, valor, data, categoria, observacao, transferencia, pago')
    .eq('grupo_id', wallet.grupo_id).eq('carteira_nome', wallet.nome)
    .gte('data', desdeLanc).order('id'));
  const COLS = 'id, tipo, valor, data, vencimento, categoria, transacao_id, origem, conta_id, forma_pagamento, status, pago_em';
  const recentes = await lerTudo(() => supabase.from('lancamentos_negocio')
    .select(COLS).eq('empresa_id', conta.empresa_id).gte('data', desdeLanc).order('id'));
  // ⚠️ CONTAS EM ABERTO entram pela data de VENCIMENTO, não pela do lançamento:
  // a mensalidade cadastrada em agosto que vence nesta semana tem `data` de
  // agosto e ficaria de fora — e o Pix dela entraria como receita nova.
  const emAberto = await lerTudo(() => supabase.from('lancamentos_negocio')
    .select(COLS).eq('empresa_id', conta.empresa_id).eq('status', 'pendente')
    .is('transacao_id', null).gte('vencimento', desdeLanc).order('id'));
  const vistos = new Set(recentes.map((l) => l.id));
  const lancamentos = [...recentes, ...emAberto.filter((l) => !vistos.has(l.id))];

  const regras = await require('./regrasNegocio').carregarRegras(conta.empresa_id, { supabase });
  const plano = planejarEspelho({
    transacoes, lancamentos, desde, contaId: conta.id, empresaId: conta.empresa_id, userId: conta.user_id, regras,
  });

  let inseridos = 0;
  if (plano.inserir.length) {
    const { error } = await supabase.from('lancamentos_negocio').insert(plano.inserir);
    if (!error) inseridos = plano.inserir.length;
    else {
      // Um conflito no índice único (passada simultânea) derruba o lote
      // inteiro — refaz um a um e ignora só o que já entrou.
      for (const row of plano.inserir) {
        const { error: e1 } = await supabase.from('lancamentos_negocio').insert(row);
        if (!e1) inseridos++;
        else if (e1.code !== '23505') throw e1;
      }
    }
  }
  let juntados = 0;
  for (const j of plano.juntar) {
    // `.is('transacao_id', null)`: só junta se ninguém juntou no meio-tempo.
    const { error } = await supabase.from('lancamentos_negocio')
      .update({ transacao_id: j.transacaoId, ...j.patch }).eq('id', j.lancamentoId).is('transacao_id', null);
    if (!error) juntados++;
    else if (error.code !== '23505') throw error;
  }
  let atualizados = 0;
  for (const u of plano.atualizar) {
    const { error } = await supabase.from('lancamentos_negocio').update(u.patch).eq('id', u.lancamentoId);
    if (error) throw error;
    atualizados++;
  }
  // Passo B: o que acabou de entrar no caixa sai das finanças pessoais.
  let foraDoPessoal = 0;
  if (conta.fora_do_pessoal !== false) {
    foraDoPessoal = await marcarEmpresa(idsLigadosNaPassada(plano), true, { supabase });
  }
  return { inseridos, juntados, atualizados, foraDoPessoal };
}

/**
 * Depois do sync do Open Finance: espelha toda conta da empresa vinculada a
 * uma carteira deste consentimento. ⚠️ Nunca derruba o sync — falha aqui é log.
 */
async function espelharDoConsentimento(consentId, { supabase = require('../db/supabase') } = {}) {
  try {
    const { data: ws, error } = await supabase.from('wallets').select('id').eq('of_consent_id', String(consentId));
    if (error || !ws || !ws.length) return [];
    const { data: contas, error: e2 } = await supabase.from('contas_negocio')
      .select('id').in('wallet_id', ws.map((w) => w.id)).eq('ativa', true);
    if (e2 || !contas) return [];   // 189 pendente: a coluna não existe → nada a fazer
    const out = [];
    for (const c of contas) {
      try { out.push({ conta: c.id, ...(await espelharConta(c.id, { supabase })) }); }
      catch (e) { console.warn('[espelho] conta', c.id, e.message); }
    }
    return out;
  } catch (e) {
    console.warn('[espelho] consentimento', consentId, e.message);
    return [];
  }
}

module.exports = {
  motivoInelegivel, espelharConta, espelharDoConsentimento,
  CAT_A_CLASSIFICAR, CAT_MOVIMENTACAO,
  ehMovimentacao, transacaoEhMovimento, diaSP, planejarEspelho, lancamentoDaTransacao, inicioDoMesSP,
  MARCA_EMPRESA, idsLigadosNaPassada, aplicarForaDoPessoal,
};
