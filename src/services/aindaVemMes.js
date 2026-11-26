// =============================================================================
// O QUE AINDA VEM NO MÊS — o "vai sobrar" no SERVIDOR (nov/2026).
//
// ⚠️ É CÓPIA FIEL de sora-frontend/lib/ainda-vem-mes.ts + saldo-projetado.ts
// (as funções que o widget usa). Existe porque o widget "Livre pra gastar" tem
// de mostrar o MESMO número da aba Previstos, do card da aba Transações e dos
// Relatórios — e o widget é alimentado pelo servidor, não pelo painel.
//
// Aqui o painel é que manda: ele nasceu primeiro e é o que o cliente vê. Mexeu
// lá, mexa aqui — `npm run eval:ainda-vem-mes-back` (no frontend) compara os
// dois lados, função a função, em milhares de casos.
//
// Sem dependência nova: o vencimento da dívida é o `proximoVencimento` de
// vencimentoDivida.js (canônico) e o "vence neste dia" das contas fixas é o
// `venceHoje` de frequenciaRecorrencia.js (canônico — o do painel é porte dele).
// =============================================================================

const { proximoVencimento } = require('./vencimentoDivida');
const { venceHoje, ultimoDiaDoMes } = require('./frequenciaRecorrencia');

const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');

const hojeISO = (agora = new Date()) => agora.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** Dia de hoje no fuso de São Paulo — nunca `getDate()` local nem UTC. */
function diaHojeSP(agora = new Date()) {
  return parseInt(hojeISO(agora).slice(8, 10), 10);
}

// ── frequência (porte de ocorrenciasNoMes/ocorrenciasRestantes do painel) ──

function ocorrenciasNoMes(r, ym, deDia = 1) {
  const [ano, mes] = String(ym).slice(0, 7).split('-').map(Number);
  if (!ano || !mes) return 0;
  const freq = r.frequencia || 'mensal';
  const semAgenda = freq === 'semanal'
    ? !Number.isInteger(Number(r.dia_semana))
    : freq === 'anual'
      ? !Number(r.mes_vencimento)
      : !Number(r.dia_vencimento);
  if (semAgenda) {
    const inicio = r.data_inicio ? String(r.data_inicio).slice(0, 7) : null;
    const fim = r.data_fim ? String(r.data_fim).slice(0, 7) : null;
    const mesRef = `${ano}-${pad(mes)}`;
    if (inicio && mesRef < inicio) return 0;
    if (fim && mesRef > fim) return 0;
    return 1;
  }
  const ultimo = ultimoDiaDoMes(ano, mes);
  let n = 0;
  for (let d = Math.max(1, deDia); d <= ultimo; d += 1) {
    if (venceHoje(r, `${ano}-${pad(mes)}-${pad(d)}`)) n += 1;
  }
  return n;
}

function ocorrenciasRestantes(r, hoje) {
  const iso = String(hoje).slice(0, 10);
  return ocorrenciasNoMes(r, iso.slice(0, 7), Number(iso.slice(8, 10)));
}

// ── saldo-projetado ─────────────────────────────────────────────────────────

/** O item AINDA VAI ACONTECER neste mês? Com `venc` (data inteira) compara a DATA. */
function aindaVemNoMes(i, agora = new Date()) {
  if (i.venc) return String(i.venc).slice(0, 10) >= hojeISO(agora);
  return !i.dia_vencimento || i.dia_vencimento >= diaHojeSP(agora);
}

/** Recorrência do banco → item previsto (sem perder frequência e duração). */
function itemPrevistoDe(r) {
  return {
    tipo: r.tipo,
    valor: Number(r.valor) || 0,
    dia_vencimento: Number(r.dia_vencimento) || 0,
    valor_variavel: r.valor_variavel ?? undefined,
    frequencia: r.frequencia ?? undefined,
    dia_semana: r.dia_semana ?? undefined,
    mes_vencimento: r.mes_vencimento ?? undefined,
    data_inicio: r.data_inicio ?? undefined,
    data_fim: r.data_fim ?? undefined,
  };
}

/** Quantas vezes a recorrência AINDA cai neste mês (0 = já passou). */
function vezesQueAindaVem(i, agora = new Date()) {
  if (i.frequencia && i.frequencia !== 'mensal') return ocorrenciasRestantes(i, hojeISO(agora));
  return aindaVemNoMes(i, agora) ? 1 : 0;
}

function calcularSaldoProjetado(carteiras, previstos, parcelas = [], agora = new Date()) {
  const saldoHoje = cent((carteiras || [])
    .filter((c) => c.tipo !== 'Crédito')
    .reduce((s, c) => s + (Number(c.saldo) || 0), 0));

  const todos = [...(previstos || []), ...(parcelas || [])]
    .map((i) => ({ item: i, n: vezesQueAindaVem(i, agora) }))
    .filter((x) => x.n > 0);

  const soma = (tipo) => cent(todos
    .filter((x) => x.item.tipo === tipo)
    .reduce((s, x) => s + ((Number(x.item.valor) || 0) * x.n), 0));

  const aReceber = soma('Recebimento');
  const aPagar = soma('Gasto');
  return {
    saldoHoje,
    aReceber,
    aPagar,
    projetado: cent(saldoHoje + aReceber - aPagar),
    aproximado: todos.some((x) => x.item.valor_variavel),
    itens: todos.length,
  };
}

// ── ainda-vem-mes ───────────────────────────────────────────────────────────

/** A parcela de dívida AINDA cai neste mês? Pelo `proximoVencimento` (sabe do pagamento adiantado). */
function parcelaAindaNoMes(d, agora = new Date()) {
  const hoje = hojeISO(agora);
  const prox = proximoVencimento(d, hoje);
  return !!prox && prox.data.slice(0, 7) === hoje.slice(0, 7);
}

function previstosRestantesDoMes({ recorrencias, dividas, faturas, agora } = {}) {
  const ag = agora ?? new Date();
  const diaHoje = diaHojeSP(ag);

  const fixas = (recorrencias || [])
    .filter((r) => r.ativa !== false && !r.resolvida_no_mes)
    .map((r) => {
      const item = itemPrevistoDe(r);
      const naoMensal = !!r.frequencia && r.frequencia !== 'mensal';
      const vezes = naoMensal
        ? vezesQueAindaVem(item, ag)
        : ((r.modo_lancamento || 'lancar') === 'nao_lancar'
          ? (aindaVemNoMes(item, ag) ? 1 : 0)
          : (Number(r.dia_vencimento) > diaHoje ? 1 : 0));
      return { r, vezes };
    })
    .filter((x) => x.vezes > 0 && Number(x.r.valor) > 0)
    .map(({ r, vezes }) => ({
      chave: `rec:${r.id}`,
      titulo: r.descricao || r.categoria || 'Conta fixa',
      tipo: r.tipo,
      valor: (Number(r.valor) || 0) * vezes,
      dia: Number(r.dia_vencimento) || 0,
      variavel: !!r.valor_variavel,
      origem: vezes > 1 ? `Conta fixa · ${vezes}x no mês` : 'Conta fixa',
      vezes,
      ref: r,
    }));

  const parcelas = (dividas || [])
    .filter((d) => d.status !== 'quitada' && Number(d.valor_parcela) > 0 && d.nos_previstos !== false)
    .filter((d) => parcelaAindaNoMes(d, ag))
    .map((d) => ({
      chave: `div:${d.id}`,
      titulo: d.titulo || 'Dívida',
      tipo: 'Gasto',
      valor: Number(d.valor_parcela) || 0,
      dia: Number(d.dia_vencimento) || 0,
      variavel: false,
      origem: 'Parcela de dívida',
      vezes: 1,
      ref: d,
    }));

  const fats = (faturas || [])
    .filter((f) => Number(f.restante) > 0.01 && f.nos_previstos !== false
      && aindaVemNoMes({ tipo: 'Gasto', valor: Number(f.restante), dia_vencimento: 0, venc: f.venc ? String(f.venc) : undefined }, ag))
    .map((f) => ({
      chave: `fat:${f.cartao_id}`,
      titulo: `Fatura ${f.nome || 'do cartão'}`,
      tipo: 'Gasto',
      valor: Number(f.restante) || 0,
      dia: parseInt(String(f.venc || '').slice(8, 10), 10) || 0,
      variavel: false,
      origem: 'Fatura de cartão',
      vezes: 1,
      ref: f,
    }));

  return [...fixas, ...parcelas, ...fats].sort((a, b) => a.dia - b.dia);
}

/** Lançamentos PENDENTES que ainda mexem no caixa (cartão e transferência fora). */
function pendentesDoCaixa(txs, nomesCartao) {
  return (txs || []).filter((t) => !t.pago && !t.transferencia
    && (t.tipo === 'Gasto' || t.tipo === 'Recebimento')
    && !nomesCartao.has(String(t.carteira_nome || t.wallet_nome || '').trim().toLowerCase()));
}

function nomesDeCartao(wallets) {
  return new Set((wallets || []).filter((w) => w.tipo === 'Crédito').map((w) => String(w.nome || '').trim().toLowerCase()));
}

function itensDoSaldoProjetado(restantes, pendentes) {
  return [
    ...restantes.map((i) => ({ tipo: i.tipo, valor: i.valor, dia_vencimento: 0, valor_variavel: i.variavel || undefined })),
    ...pendentes.map((t) => ({ tipo: t.tipo, valor: Number(t.valor) || 0, dia_vencimento: 0 })),
  ];
}

module.exports = {
  diaHojeSP, ocorrenciasNoMes, ocorrenciasRestantes,
  aindaVemNoMes, itemPrevistoDe, vezesQueAindaVem, calcularSaldoProjetado,
  parcelaAindaNoMes, previstosRestantesDoMes, pendentesDoCaixa, nomesDeCartao, itensDoSaldoProjetado,
};
