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
    }).eq('id', alvo.id);

    if (error) { restantes.push(real); continue; } // falhou → insere normal
    usadas.add(alvo.id);
    reconciliadas++;
    console.log(`[reconciliar] previsão "${alvo.observacao}" (R$ ${alvo.valor}) virou "${real.observacao}" (R$ ${real.valor})`);
  }

  return { restantes, reconciliadas };
}

module.exports = {
  reconciliar, casarPrevisao, valorCompativel, diasEntre, previsoesEmAberto,
  TOLERANCIA_PCT, TOLERANCIA_MIN, JANELA_DIAS,
};
