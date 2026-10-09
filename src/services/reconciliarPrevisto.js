// =====================================================================
// Reconciliação PREVISÃO × cobrança real do Open Finance.
//
// Existem dois geradores pro MESMO fato: a recorrência PROJETA o que vai
// acontecer e o Open Finance IMPORTA o que aconteceu. Enquanto os dois criarem
// transação paga, o gasto conta em dobro nos relatórios.
//
// Solução: recorrência em conta conectada nasce como PREVISÃO (pago=false,
// sem debitar saldo) e, quando a cobrança real chega, ela ASSUME a previsão —
// a mesma linha vira a transação real (valor, data e descrição do banco).
// Fundir em vez de apagar+inserir preserva o vínculo com a recorrência e não
// destrói nada que o usuário tenha editado à mão.
//
// ⚠️ O casamento é DELIBERADAMENTE conservador. Caso real medido:
//   previsão "Claude R$ 113,50 dia 13"  ×  real "ANTHROPIC* CLAUDE SUB
//   R$ 113,85 em 14/07" — valor diferente (câmbio), data diferente, descrição
//   totalmente diferente. Casar por descrição é impossível; por valor+data+conta
//   é o que dá pra fazer sem inventar. Na dúvida NÃO casa: uma duplicata visível
//   o usuário resolve; um gasto real engolido por engano ele nunca descobre.
// =====================================================================
const supabase = require('../db/supabase');

// Tolerâncias. Valor: 15% ou R$ 5 (o que for maior) — cobre câmbio (o caso do
// Claude variou 0,3%) e reajuste pequeno. Data: 7 dias, porque cobrança cai em
// dia útil e cartão lança com atraso.
const TOLERANCIA_PCT = 0.15;
const TOLERANCIA_MIN = 5;
const JANELA_DIAS = 7;

const ymd = (d) => (d ? String(d).slice(0, 10) : null);
const norm = (s) => (s || '').toString().trim().toLowerCase();

function diasEntre(a, b) {
  const da = new Date(`${ymd(a)}T12:00:00Z`).getTime();
  const db = new Date(`${ymd(b)}T12:00:00Z`).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Infinity;
  return Math.abs(da - db) / 86400000;
}

function valorCompativel(previsto, real) {
  const p = Math.abs(Number(previsto) || 0);
  const r = Math.abs(Number(real) || 0);
  if (!p || !r) return false;
  const tolerancia = Math.max(p * TOLERANCIA_PCT, TOLERANCIA_MIN);
  return Math.abs(p - r) <= tolerancia;
}

/**
 * Previsões em aberto do grupo (criadas pelo cron de recorrências).
 * `recorrente = true` + `pago = false` é a marca — transação avulsa pendente
 * que o usuário criou à mão NÃO tem a flag, então não entra na reconciliação.
 */
async function previsoesEmAberto(grupoId) {
  if (!grupoId) return [];
  try {
    const { data, error } = await supabase.from('transacoes')
      .select('id, tipo, valor, data, carteira_nome, categoria, observacao')
      .eq('grupo_id', grupoId).eq('recorrente', true).eq('pago', false)
      .is('of_tx_id', null);
    if (error) throw error;
    return data || [];
  } catch {
    return []; // coluna/flag ausente → sem reconciliação, comportamento antigo
  }
}

/**
 * Escolhe a previsão que a transação real veio quitar. `null` = nenhuma casa.
 * Critérios (todos obrigatórios): mesmo tipo, mesma conta, valor dentro da
 * tolerância e data dentro da janela. Empate → menor diferença de valor.
 */
function casarPrevisao(previsoes, real) {
  const candidatas = (previsoes || []).filter((p) =>
    norm(p.tipo) === norm(real.tipo)
    && norm(p.carteira_nome) === norm(real.carteira_nome)
    && valorCompativel(p.valor, real.valor)
    && diasEntre(p.data, real.data) <= JANELA_DIAS);
  if (!candidatas.length) return null;
  return candidatas.sort((a, b) =>
    Math.abs(a.valor - real.valor) - Math.abs(b.valor - real.valor))[0];
}

/**
 * Funde as transações do Open Finance com as previsões em aberto.
 *
 * Recebe as linhas prontas pra inserir e devolve só as que SOBRARAM (as que
 * casaram viraram UPDATE na previsão). Assim o chamador insere o resto normal.
 */
async function reconciliar(grupoId, novas) {
  const linhas = (novas || []).filter(Boolean);
  if (!grupoId || !linhas.length) return { restantes: linhas, reconciliadas: 0 };

  const previsoes = await previsoesEmAberto(grupoId);
  if (!previsoes.length) return { restantes: linhas, reconciliadas: 0 };

  const usadas = new Set();
  const restantes = [];
  let reconciliadas = 0;

  for (const real of linhas) {
    const alvo = casarPrevisao(previsoes.filter((p) => !usadas.has(p.id)), real);
    if (!alvo) { restantes.push(real); continue; }

    // A previsão VIRA a transação real: valor/data/descrição do banco mandam.
    // Mantém `recorrente` pra continuar ligada à recorrência que a gerou.
    const { error } = await supabase.from('transacoes').update({
      valor: real.valor,
      data: real.data,
      observacao: real.observacao,
      categoria: real.categoria,
      carteira_nome: real.carteira_nome,
      pago: true,
      of_tx_id: real.of_tx_id || null,
      of_card: real.of_card || null,
      // Conta fora da moeda base do grupo (migration 168): o valor ORIGINAL e a
      // taxa também passam a ser os do banco — senão a linha ficaria com o
      // nativo da PREVISÃO. Só quando a linha do banco os traz: em conta na
      // base o update sai idêntico ao de antes.
      ...('moeda' in real ? { moeda: real.moeda, valor_moeda: real.valor_moeda, taxa_brl: real.taxa_brl } : {}),
    }).eq('id', alvo.id);

    if (error) { restantes.push(real); continue; } // falhou → insere normal
    usadas.add(alvo.id);
    reconciliadas++;
    console.log(`[reconciliar] previsão "${alvo.observacao}" (R$ ${alvo.valor}) virou "${real.observacao}" (R$ ${real.valor})`);
  }

  return { restantes, reconciliadas };
}

// =============================================================================
// ABSORÇÃO DO PREVISTO MANUAL — o mesmo "assume a previsão", mas pro lançamento
// que o usuário DIGITOU à mão (pendente), não pra recorrência.
//
// Roda DEPOIS do `reconciliar` acima, sobre o que SOBROU — então não toca no
// caminho da recorrência (zero regressão lá). E é mais CONSERVADOR:
//
//   · a PROVA é o `ehDuplicata` do Watson ('manual-e-banco') — mesmo valor,
//     mesma conta, ≤1 dia, origem diferente. Zero tolerância nova.
//   · só junta par 1-pra-1 SEM ambiguidade (escolherAbsorcoes). Disputa → fica
//     de fora e vira sugestão do Watson.
//
// ⚠️ MUTAÇÃO MÍNIMA, de propósito: a previsão vira a real mexendo SÓ em
// `pago`, `of_tx_id`, `of_card` e o marco `absorvido_auto_em`. Valor e data
// NÃO são tocados (o valor é idêntico — o ehDuplicata exige igualdade — e a
// data está a ≤1 dia), e o RÓTULO do usuário (observacao/categoria) é
// preservado por construção. Isso é o que torna o DESFAZER trivial: basta
// soltar pago/of_tx_id e o próximo sync reimporta a cobrança.
//
// ⚠️ SALDO não é tocado, e é seguro: a cobrança veio do Open Finance, logo a
// conta é de OF, cujo saldo é do banco — igual à reconciliação de recorrência.
//
// ⚠️ TOLERANTE DE PONTA A PONTA: qualquer falha devolve "não absorvi nada" e o
// sync insere tudo como antes. E há interruptor: OF_ABSORVER_MANUAL=0 desliga.
// =============================================================================
async function absorverManuais(grupoId, novas) {
  const linhas = (novas || []).filter(Boolean);
  const vazio = { restantes: linhas, absorvidas: 0 };
  if (process.env.OF_ABSORVER_MANUAL === '0') return vazio;      // kill-switch
  if (!grupoId || !linhas.length) return vazio;

  try {
    const { ehDuplicata } = require('./duplicadas');
    const { escolherAbsorcoes } = require('./fusaoDuplicada');

    // Previsões manuais pendentes: pago=false, sem of_tx_id, NÃO recorrência
    // (essas já passaram pelo reconciliar). Colunas do que o ehDuplicata lê.
    // ⚠️ `IS NOT TRUE`, não `!= true`: em Postgres `recorrente <> true` EXCLUI
    // as linhas com `recorrente` NULL (comparação com null é "unknown"). Um
    // previsto manual pode nascer com recorrente=null — `IS NOT TRUE` pega
    // false E null, que é o conjunto certo de "não é recorrência".
    const { data: prevs, error } = await supabase.from('transacoes')
      .select('id, valor, valor_moeda, tipo, observacao, carteira_nome, data, of_tx_id, pluggy_tx_id, parcela_total, recorrente, pago')
      .eq('grupo_id', grupoId).eq('pago', false).is('of_tx_id', null).not('recorrente', 'is', true);
    if (error) throw error;
    if (!prevs || !prevs.length) return vazio;

    const pares = escolherAbsorcoes(prevs, linhas, (p, c) => ehDuplicata(p, c) === 'manual-e-banco');
    if (!pares.length) return vazio;

    const absorvidasIds = new Set();   // of_tx_id das cobranças que foram absorvidas
    let n = 0;
    for (const { previsao, cobranca } of pares) {
      const patch = {
        pago: true,
        of_tx_id: cobranca.of_tx_id || null,
        of_card: cobranca.of_card || null,
        absorvido_auto_em: new Date().toISOString(),
      };
      const { error: errUp } = await supabase.from('transacoes')
        .update(patch).eq('id', previsao.id).eq('grupo_id', grupoId);
      // ⚠️ Se a coluna `absorvido_auto_em` não existe (migration 184 pendente),
      // este update FALHA e a cobrança é inserida normal — ou seja, a absorção
      // automática SÓ LIGA depois da migration. É de propósito: sem o marco não
      // há "desfazer", e não quero fundir sozinho sem rede. Antes da 184, o
      // comportamento é idêntico ao de hoje.
      if (errUp) continue;              // falhou (inclui coluna ausente) → insere normal
      absorvidasIds.add(cobranca.of_tx_id);
      n++;
      console.log(`[absorverManuais] previsão "${previsao.observacao}" (R$ ${previsao.valor}) assumiu a cobrança do banco "${cobranca.observacao}"`);
    }

    const restantes = linhas.filter((c) => !absorvidasIds.has(c.of_tx_id));
    return { restantes, absorvidas: n };
  } catch {
    return vazio;                       // qualquer erro: insere tudo, como antes
  }
}

module.exports = {
  reconciliar, absorverManuais, casarPrevisao, valorCompativel, diasEntre, previsoesEmAberto,
  TOLERANCIA_PCT, TOLERANCIA_MIN, JANELA_DIAS,
};
