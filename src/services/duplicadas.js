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

/**
 * O que NUNCA entra em análise nenhuma: repete por natureza ou não é lançamento.
 * Parcela e conta fixa se repetem de propósito — acusá-las seria sempre errado.
 */
function elegivelBase(t) {
  if (!t) return false;
  if (t.parcela_total) return false;      // parcela repete de propósito
  if (t.recorrente) return false;         // conta fixa idem
  return Number(t.valor) > 0;
}

/**
 * Elegível pras regras de CONSUMO (mesmo-instante e suspeita).
 *
 * Transferência e recebimento ficam de fora aqui porque essas regras olham
 * "comprei a mesma coisa duas vezes?" — e transferência não é compra.
 */
function elegivel(t) {
  return elegivelBase(t) && t.tipo === 'Gasto' && !t.transferencia;
}

const daOF = (t) => !!(t.of_tx_id || t.pluggy_tx_id);

/**
 * Os dois lançamentos são a MESMA compra entrada duas vezes?
 * Devolve o motivo (string) ou `null`.
 */
function ehDuplicata(a, b) {
  if (!elegivelBase(a) || !elegivelBase(b)) return null;
  if (a.id && b.id && a.id === b.id) return null;
  if (Number(a.valor) !== Number(b.valor)) return null;

  // ⚠️⚠️ AS DUAS TRAVAS QUE PROTEGEM O PAGAMENTO DE FATURA ⚠️⚠️
  //
  // O Open Finance traz a quitação da fatura pelas DUAS PONTAS, e isso é
  // CORRETO — não é duplicata. Caso real medido (R$ 70,00 em 09/06):
  //
  //   Gasto        R$70  carteira "Banco"     "Pagamento de fatura"
  //   Recebimento  R$70  carteira "platinum"  "Pagamento recebido"
  //
  // Mesmo valor, mesmo instante. O que as separa é a CARTEIRA (a conta que
  // pagou × o cartão que recebeu) e o TIPO (saída × entrada). Exigir os dois
  // iguais é o que impede o agente de mandar apagar metade de uma quitação
  // legítima — e deixar o cartão com a fatura eternamente em aberto.
  //
  // A trava de tipo é NOVA: antes ela existia por acidente, porque `elegivel`
  // forçava tudo a 'Gasto'. Ao abrir a regra pra transferência e recebimento,
  // ela vira explícita — senão as duas pernas passariam a casar.
  if (a.tipo !== b.tipo) return null;
  if (normTexto(a.carteira_nome) !== normTexto(b.carteira_nome)) return null;

  const mesmaDesc = normTexto(a.observacao) === normTexto(b.observacao);

  // 1. Prova forte: o mesmo instante, ao milissegundo.
  //
  // ⚠️ Esta regra continua SÓ EM CONSUMO (`elegivel`), de propósito. Ela não
  // precisou mudar pra resolver o caso do cliente — as 9 duplicatas dele são
  // todas manual × banco — e abrir as duas de uma vez ampliaria o raio sem
  // necessidade. Mudança de dinheiro se faz uma de cada vez.
  if (elegivel(a) && elegivel(b)
      && mesmaDesc && temHoraReal(a.data) && temHoraReal(b.data)
      && String(a.data) === String(b.data)) {
    return 'mesmo-instante';
  }

  // 2. O mesmo lançamento entrando por dois caminhos: digitado/importado de
  //    arquivo e trazido pelo banco.
  //
  // ⚠️ Esta regra vale pra TRANSFERÊNCIA e RECEBIMENTO também (antes era só
  // 'Gasto'). O que ela prova é a ORIGEM DIFERENTE — a mesma linha não pode
  // ter vindo de duas fontes —, e isso independe de o lançamento ser consumo.
  // Caso real: cliente importou o extrato em OFX e no dia seguinte conectou o
  // Open Finance; das 9 duplicatas geradas, o agente pegava só 1, porque
  // pagamento de fatura e transferência recebida caíam fora do filtro.
  if (daOF(a) !== daOF(b) && diffDias(a.data, b.data) <= 1) {
    return 'manual-e-banco';
  }

  return null;
}

/**
 * SUSPEITA (≠ duplicata): mesmo valor, mesma carteira, MESMA descrição, ≤1 dia.
 *
 * ⚠️ Esta regra é sabidamente RUIDOSA — é a mesma que, medida na base (4.357
 * gastos), acusa 27 pares em que a MAIORIA é legítima (dois Pix de R$ 17,80 pro
 * mesmo comerciante no mesmo dia acontece). Por isso ela NUNCA entra no aviso
 * proativo do WhatsApp nem vem pré-selecionada: só aparece num bloco separado
 * do painel, rotulado como "pode ser", pro usuário decidir olhando.
 *
 * A diferença pra `ehDuplicata` é de PROVA, não de força de palpite: lá existe
 * evidência (mesmo milissegundo, ou origens diferentes); aqui só coincidência.
 */
function ehSuspeita(a, b) {
  if (!elegivel(a) || !elegivel(b)) return null;
  if (a.id && b.id && a.id === b.id) return null;
  if (Number(a.valor) !== Number(b.valor)) return null;
  if (normTexto(a.carteira_nome) !== normTexto(b.carteira_nome)) return null;
  // Descrição igual é obrigatória aqui: sem ela sobra "mesmo valor no mesmo
  // dia", que em conta movimentada acusa qualquer coisa.
  if (normTexto(a.observacao) !== normTexto(b.observacao)) return null;
  if (diffDias(a.data, b.data) > 1) return null;
  return 'mesmo-valor-e-descricao';
}

/**
 * Agrupa lançamentos que casam por `comparar`.
 *
 * Devolve `[{ motivo, transacoes: [...] }]` — grupos, não pares, porque a
 * mesma compra pode ter entrado 3 vezes (aconteceu na base) e mostrar 3 pares
 * separados faria o usuário apagar demais.
 *
 * `ignorar` = ids já consumidos por uma análise anterior (as confirmadas), pra
 * a mesma transação não aparecer nas duas listas do painel.
 */
function agrupar(transacoes, comparar, ignorar) {
  // ⚠️ Filtra pelo BASE (parcela/recorrência/valor), não pelo `elegivel` de
  // consumo. Cada comparador aplica a própria régua: `ehSuspeita` continua
  // exigindo `elegivel` por dentro, e `ehDuplicata` decide por regra.
  //
  // Era aqui que a correção do "manual × banco" morria: as transferências
  // eram descartadas ANTES de chegar na comparação, então abrir a regra não
  // adiantava nada — o par nem era testado.
  const lista = (transacoes || []).filter((t) => elegivelBase(t) && !(ignorar && ignorar.has(t.id)));
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
      const m = grupo.map((g) => comparar(g, lista[j])).find(Boolean);
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

function acharDuplicadas(transacoes) {
  return agrupar(transacoes, ehDuplicata, null);
}

/**
 * As duas listas de uma vez, sem sobreposição.
 *
 * ⚠️ `confirmadas` é o que o Watson AFIRMA; `suspeitas` é o que ele PERGUNTA.
 * Misturar as duas destrói a confiança no agente — é a decisão central deste
 * arquivo, e o eval trava que uma transação nunca aparece nas duas.
 */
function analisar(transacoes) {
  const confirmadas = acharDuplicadas(transacoes);
  const usados = new Set();
  for (const g of confirmadas) for (const t of g.transacoes) usados.add(t.id);
  return { confirmadas, suspeitas: agrupar(transacoes, ehSuspeita, usados) };
}

/** Frase curta descrevendo a prova — é o que o Watson mostra. */
function explicar(grupo) {
  const n = grupo.transacoes.length;
  const quantas = n === 2 ? 'duas vezes' : `${n} vezes`;
  if (grupo.motivo === 'mesmo-instante') {
    return `lançada ${quantas} no mesmo instante — mesmo valor, mesma conta, mesmo segundo`;
  }
  if (grupo.motivo === 'manual-e-banco') {
    return `lançada ${quantas}: uma digitada por você e outra trazida pelo banco`;
  }
  // Suspeita: a frase precisa deixar claro que é PERGUNTA, não acusação.
  return `${quantas} o mesmo valor e a mesma descrição, com 1 dia de diferença — pode ser compra repetida de verdade`;
}

// ── Acesso ao banco ─────────────────────────────────────────────────────────

const COLUNAS = 'id, id_curto, valor, tipo, observacao, categoria, carteira_nome, data, created_at, of_tx_id, pluggy_tx_id, parcela_total, recorrente, transferencia';

/** Duplicatas do grupo nos últimos `dias`. */
async function buscarDuplicadas(grupoId, { dias = 90 } = {}) {
  if (!grupoId) return [];
  const supabase = require('../db/supabase');
  const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('transacoes')
    .select(COLUNAS)
    .eq('grupo_id', grupoId).eq('tipo', 'Gasto').gte('data', desde)
    .order('data', { ascending: false }).limit(2000);
  return acharDuplicadas(data || []);
}

/**
 * Análise sob demanda (o botão do Watson no painel e o comando no WhatsApp).
 *
 * `cartaoId` recorta pela FATURA ATUAL daquele cartão. ⚠️ Fatura NÃO é
 * mês-calendário: o ciclo vai do dia seguinte ao fechamento anterior até o
 * fechamento, e cruza meses (regra canônica em `services/cicloFatura.js`).
 * Filtrar por mês aqui traria a fatura errada — é o mesmo erro que o CLAUDE.md
 * já registra pro resto do painel.
 *
 * Cartão sem `dia_fechamento` cai no comportamento de sempre (últimos `dias`),
 * que é o mesmo fallback do resto do sistema.
 */
async function buscarAnalise(grupoId, { dias = 90, cartaoId = null } = {}) {
  if (!grupoId) return { confirmadas: [], suspeitas: [], escopo: null };
  const supabase = require('../db/supabase');

  let q = supabase.from('transacoes').select(COLUNAS)
    .eq('grupo_id', grupoId).eq('tipo', 'Gasto');
  let escopo = { tipo: 'geral', dias };

  if (cartaoId) {
    const { data: w } = await supabase.from('wallets')
      .select('id, nome, dia_fechamento, dia_vencimento')
      .eq('id', cartaoId).eq('grupo_id', grupoId).maybeSingle();

    if (w && w.dia_fechamento) {
      const { competenciaAtual, cicloPorCompetencia } = require('./cicloFatura');
      const comp = competenciaAtual(w);
      const ciclo = cicloPorCompetencia(w, comp);
      q = q.eq('carteira_nome', w.nome).gte('data', ciclo.ini).lt('data', ciclo.fimExcl);
      escopo = { tipo: 'fatura', cartao: w.nome, competencia: comp, ini: ciclo.ini, fim: ciclo.fim };
    } else if (w) {
      // Sem data de fechamento não existe ciclo — filtra só pelo cartão.
      q = q.eq('carteira_nome', w.nome)
        .gte('data', new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10));
      escopo = { tipo: 'cartao', cartao: w.nome, dias };
    }
  } else {
    q = q.gte('data', new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10));
  }

  const { data } = await q.order('data', { ascending: false }).limit(2000);
  return { ...analisar(data || []), escopo };
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
    // {{1}} abertura · {{2}} quantidade · {{3}} o valor · {{4}} a prova · {{5}} sobra + chamada
    const { aberturaDe, templateDoAviso } = require('../agentes');
    const primeiro = novos[0].transacoes[0];
    const sobraParam = novos.length > 1 ? `…e mais ${novos.length - 1}. ` : '';
    const tpl = templateDoAviso('detetive-watson', 'duplicadas', [
      aberturaDe('detetive-watson', 'duplicadas', grupoId),
      `${novos.length} cobrança${novos.length === 1 ? '' : 's'} repetida${novos.length === 1 ? '' : 's'}`,
      `${brl(primeiro.valor)} · ${String(primeiro.observacao || primeiro.categoria || 'Lançamento').slice(0, 40)}`,
      explicar(novos[0]),
      // ⚠️ Nunca vazio: sem sobra vai só a chamada. Parâmetro vazio faz a Meta
      // recusar a mensagem inteira.
      `${sobraParam}Abra o painel pra decidir qual fica.`,
    ]);
    await enviarProativo(phone, { texto: vestida.texto, template: tpl || undefined });
    return novos.length;
  } catch { return 0; }   // aviso é efeito colateral: nunca derruba o sync
}

/** Dispara sem travar quem chamou (mesmo padrão do services/limites.js). */
function avisarDuplicadasEmBackground(grupoId, phone) {
  setImmediate(() => { avisarDuplicadas(grupoId, phone).catch(() => {}); });
}

module.exports = {
  acharDuplicadas, ehDuplicata, buscarDuplicadas, explicar,
  ehSuspeita, analisar, buscarAnalise,
  avisarDuplicadas, avisarDuplicadasEmBackground,
  normTexto, temHoraReal, diffDias, elegivel,
};
