// =============================================================================
// Detector de TRANSAÇÕES DUPLICADAS — o Detetive Watson.
//
// DOR REAL: um cliente apagou 238 lançamentos à mão por causa de duplicatas do
// Open Finance, reconectou e ficou sem nada (a migration 113 impede o que foi
// apagado de voltar). Achar a duplicata PRA ELE é o trabalho do Watson.
//
// ⚠️ O PROBLEMA DIFÍCIL AQUI NÃO É ACHAR — É NÃO ACUSAR INOCENTE.
// Medido na base (4.357 gastos): "mesmo valor + mesma carteira + mesma
// descrição + ±1 dia" acusa 27 pares — e a amostra mostra que a maioria é
// LEGÍTIMA (dois Pix de R$ 17,80 pro mesmo comerciante no mesmo dia acontece).
// Se ambos vieram do banco, o BANCO diz que são duas transações; não cabe à
// Sora discordar. Um detector que grita lobo destrói a confiança no agente.
//
// Por isso a regra é ESTREITA e baseada em prova, não em palpite:
//
//  1. TIMESTAMP IDÊNTICO (com hora real, não meia-noite) + valor + carteira +
//     descrição. Duas compras de verdade não acontecem no MESMO milissegundo.
//     Medido: 6 pares na base inteira — um deles importado 3 vezes.
//
//  2. MANUAL × OPEN FINANCE, mesmo valor/carteira, ±1 dia. A pessoa digitou e
//     o banco trouxe a mesma compra depois. Aqui a hora não serve de prova
//     (o lançamento manual nasce à meia-noite), mas a ORIGEM diferente já é a
//     prova: é o mesmo gasto entrando por dois caminhos.
//
// Fica DE FORA de propósito: parcelas e recorrências (repetem por natureza),
// transferências, e pares em que os dois lados vieram do banco com horas
// diferentes — nesses o banco já disse que são transações distintas.
// =============================================================================

/** Texto comparável: sem acento, sem pontuação, minúsculo. */
function normTexto(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const soData = (d) => String(d || '').slice(0, 10);

/** A data tem HORA de verdade? Lançamento manual nasce 00:00:00 e não serve de prova. */
function temHoraReal(d) {
  const s = String(d || '');
  if (s.length <= 10) return false;
  const hora = s.slice(11, 19);
  return !!hora && hora !== '00:00:00';
}

/** Distância em dias entre duas transações (só a parte da data). */
function diffDias(a, b) {
  const x = Date.parse(`${soData(a)}T12:00:00Z`);
  const y = Date.parse(`${soData(b)}T12:00:00Z`);
  if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
  return Math.abs(Math.round((x - y) / 86400000));
}

/** Transação que NUNCA entra na análise (repete por natureza ou não é consumo). */
function elegivel(t) {
  if (!t || t.tipo !== 'Gasto') return false;
  if (t.parcela_total) return false;      // parcela repete de propósito
  if (t.recorrente) return false;         // conta fixa idem
  if (t.transferencia) return false;      // não é consumo
  return Number(t.valor) > 0;
}

const daOF = (t) => !!(t.of_tx_id || t.pluggy_tx_id);

/**
 * Os dois lançamentos são a MESMA compra entrada duas vezes?
 * Devolve o motivo (string) ou `null`.
 */
function ehDuplicata(a, b) {
  if (!elegivel(a) || !elegivel(b)) return null;
  if (a.id && b.id && a.id === b.id) return null;
  if (Number(a.valor) !== Number(b.valor)) return null;
  if (normTexto(a.carteira_nome) !== normTexto(b.carteira_nome)) return null;

  const mesmaDesc = normTexto(a.observacao) === normTexto(b.observacao);

  // 1. Prova forte: o mesmo instante, ao milissegundo.
  if (mesmaDesc && temHoraReal(a.data) && temHoraReal(b.data)
      && String(a.data) === String(b.data)) {
    return 'mesmo-instante';
  }

  // 2. A mesma compra entrando por dois caminhos: digitada e importada.
  if (daOF(a) !== daOF(b) && diffDias(a.data, b.data) <= 1) {
    return 'manual-e-banco';
  }

  return null;
}

/**
 * Agrupa as duplicatas de uma lista de transações.
 *
 * Devolve `[{ motivo, transacoes: [...] }]` — grupos, não pares, porque a
 * mesma compra pode ter entrado 3 vezes (aconteceu na base) e mostrar 3 pares
 * separados faria o usuário apagar demais.
 */
function acharDuplicadas(transacoes) {
  const lista = (transacoes || []).filter(elegivel);
  const visto = new Set();
  const grupos = [];

  for (let i = 0; i < lista.length; i++) {
    if (visto.has(lista[i].id)) continue;
    const grupo = [lista[i]];
    let motivo = null;

    for (let j = i + 1; j < lista.length; j++) {
      if (visto.has(lista[j].id)) continue;
      // Compara com QUALQUER um já no grupo: o 3º lançamento pode casar com o
      // 2º e não com o 1º (horas diferentes, origens diferentes).
      const m = grupo.map((g) => ehDuplicata(g, lista[j])).find(Boolean);
      if (!m) continue;
      grupo.push(lista[j]);
      visto.add(lista[j].id);
      motivo = motivo || m;
    }

    if (grupo.length > 1) {
      visto.add(lista[i].id);
      // O mais ANTIGO primeiro: é o que o usuário provavelmente quer manter
      // (foi o primeiro a entrar), e o painel sugere apagar os seguintes.
      grupo.sort((x, y) => String(x.created_at || x.data).localeCompare(String(y.created_at || y.data)));
      grupos.push({ motivo, transacoes: grupo });
    }
  }
  return grupos;
}

/** Frase curta descrevendo a prova — é o que o Watson mostra. */
function explicar(grupo) {
  const n = grupo.transacoes.length;
  const quantas = n === 2 ? 'duas vezes' : `${n} vezes`;
  return grupo.motivo === 'mesmo-instante'
    ? `lançada ${quantas} no mesmo instante — mesmo valor, mesma conta, mesmo segundo`
    : `lançada ${quantas}: uma digitada por você e outra trazida pelo banco`;
}

// ── Acesso ao banco ─────────────────────────────────────────────────────────

/** Duplicatas do grupo nos últimos `dias`. */
async function buscarDuplicadas(grupoId, { dias = 90 } = {}) {
  if (!grupoId) return [];
  const supabase = require('../db/supabase');
  const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('transacoes')
    .select('id, id_curto, valor, tipo, observacao, categoria, carteira_nome, data, created_at, of_tx_id, pluggy_tx_id, parcela_total, recorrente, transferencia')
    .eq('grupo_id', grupoId).eq('tipo', 'Gasto').gte('data', desde)
    .order('data', { ascending: false }).limit(2000);
  return acharDuplicadas(data || []);
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Avisa o dono do grupo sobre duplicatas RECÉM-APARECIDAS.
 *
 * ⚠️ Só entra grupo com lançamento criado nas últimas 24h. Sem esse corte, o
 * Watson repetiria o mesmo alerta a cada sync até a pessoa resolver — e agente
 * que repete vira notificação silenciada. Assim ele fala quando a duplicata
 * APARECE, e depois cala.
 *
 * Tolerante de ponta a ponta: nada aqui pode derrubar o sync que o chamou.
 */
async function avisarDuplicadas(grupoId, fallbackPhone) {
  try {
    const grupos = await buscarDuplicadas(grupoId, { dias: 30 });
    if (!grupos.length) return 0;

    const limite = Date.now() - 24 * 3600 * 1000;
    const novos = grupos.filter((g) => g.transacoes.some(
      (t) => Date.parse(t.created_at || t.data) >= limite));
    if (!novos.length) return 0;

    const supabase = require('../db/supabase');
    const { avisosLigados } = require('./avisos');
    const { enviarProativo } = require('./proativo');
    const { falar, templateAgente } = require('../agentes');

    const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).maybeSingle();
    let phone = fallbackPhone;
    if (grupo?.dono_id) {
      if (!(await avisosLigados(grupo.dono_id))) return 0;       // kill-switch
      const { data: u } = await supabase.from('users').select('phone').eq('id', grupo.dono_id).maybeSingle();
      phone = u?.phone || phone;
    }
    if (!phone) return 0;

    const itens = novos.slice(0, 5).map((g) => {
      const t = g.transacoes[0];
      return `💸 ${brl(t.valor)} · ${String(t.observacao || t.categoria || 'Lançamento').slice(0, 40)}`
        + `\n   _${explicar(g)}_`;
    });
    const sobra = novos.length > itens.length ? `\n\n…e mais ${novos.length - itens.length}.` : '';

    const texto = `🔍 *Achei lançamentos repetidos*\n\n${itens.join('\n\n')}${sobra}`
      + `\n\nAbra o painel pra decidir qual fica.`;
    const core = `Achei ${novos.length} lançamento(s) repetido(s), começando por `
      + `${brl(novos[0].transacoes[0].valor)} (${explicar(novos[0])}). Abra o painel pra decidir qual fica.`;

    const vestida = falar('detetive-watson', 'duplicadas', { texto, core, seed: grupoId });
    await enviarProativo(phone, {
      texto: vestida.texto,
      template: templateAgente('detetive-watson', vestida.coreAgente) || undefined,
    });
    return novos.length;
  } catch { return 0; }   // aviso é efeito colateral: nunca derruba o sync
}

/** Dispara sem travar quem chamou (mesmo padrão do services/limites.js). */
function avisarDuplicadasEmBackground(grupoId, phone) {
  setImmediate(() => { avisarDuplicadas(grupoId, phone).catch(() => {}); });
}

module.exports = {
  acharDuplicadas, ehDuplicata, buscarDuplicadas, explicar,
  avisarDuplicadas, avisarDuplicadasEmBackground,
  normTexto, temHoraReal, diffDias, elegivel,
};
