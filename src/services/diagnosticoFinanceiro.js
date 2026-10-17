// =============================================================================
// DIAGNÓSTICO FINANCEIRO — a varredura que acha o erro ANTES do cliente.
//
// Por que existe: em out/2026 os relatos se repetiram (Vander, Davidson,
// Fabricio, Mayra) e em TODOS a causa já estava nos dados dias antes da
// reclamação — fatura paga aparecendo em aberto, transferência entre contas
// contando duas vezes, previsto convivendo com a cobrança do banco. A gente só
// descobria quando o cliente escrevia. Esta varredura lista, por conta, cada
// sinal desses — pra virar correção nossa, não reclamação dele.
//
// ⚠️ NENHUMA REGRA NOVA DE DINHEIRO AQUI. Cada verificação CHAMA a regra que o
// painel já usa (ehTransferencia, ehDuplicata, paresConciliaveis, faturaVista).
// Uma regra paralela diria uma coisa e a tela outra — exatamente o tipo de
// divergência que este arquivo existe pra encontrar.
//
// ⚠️ SÓ LÊ. Nada aqui grava em tabela de cliente.
//
// ⚠️ GRAVIDADE É DECISÃO, NÃO DETALHE:
//   · 'erro'     → a Sora mostra um número errado (deveria ser zero sempre);
//   · 'atencao'  → provável problema, mas pode ser legítimo (precisa de olho);
//   · 'sinal'    → candidato, com falso positivo CONHECIDO (ex.: transferência
//                  entre contas: medido, Pix de R$ 10 pra pessoas diferentes
//                  casa pelo valor). Serve pra priorizar, nunca pra agir sozinho.
//
// Eval: npm run eval:diagnostico
// =============================================================================

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const diaNum = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() / 86400000;
const ehCartao = (w) => /cr[eé]dito/i.test(String((w && w.tipo) || ''));

function porGrupo(lista) {
  const m = new Map();
  for (const x of lista || []) {
    if (!x || !x.grupo_id) continue;
    if (!m.has(x.grupo_id)) m.set(x.grupo_id, []);
    m.get(x.grupo_id).push(x);
  }
  return m;
}

// ── 1. Previsto manual que JÁ TEM a cobrança igual do banco ─────────────────
// Mesma régua do botão "Conciliar com o banco" (paresConciliaveis). Tem de ser
// zero: o sync absorve sozinho e o painel oferece o botão.
function previstosConciliaveis(transacoes, saoMesma, opts) {
  const { paresConciliaveis } = require('./fusaoDuplicada');
  const achados = [];
  for (const [grupoId, txs] of porGrupo(transacoes)) {
    for (const { previsto, banco } of paresConciliaveis(txs, saoMesma, opts)) {
      achados.push({
        grupo_id: grupoId, valor: cent(previsto.valor),
        detalhe: `previsto "${previsto.observacao || ''}" × banco "${banco.observacao || ''}" (${previsto.carteira_nome}, ${String(banco.data).slice(0, 10)})`,
      });
    }
  }
  return achados;
}

// ── 2. Duplicata CONFIRMADA (a que o Watson afirma, com prova) ──────────────
function duplicatasConfirmadas(transacoes) {
  const { analisar } = require('./duplicadas');
  const achados = [];
  for (const [grupoId, txs] of porGrupo(transacoes)) {
    for (const g of analisar(txs).confirmadas) {
      const t = g.transacoes[0];
      achados.push({
        grupo_id: grupoId,
        // O que sobra contado a mais: todas menos uma.
        valor: cent(Number(t.valor) * (g.transacoes.length - 1)),
        detalhe: `${g.motivo}: "${t.observacao || ''}" ×${g.transacoes.length} (${t.carteira_nome}, ${String(t.data).slice(0, 10)})`,
      });
    }
  }
  return achados;
}

// ── 3. Transferência entre contas PRÓPRIAS contando como gasto E receita ────
// ⚠️ 'sinal': a régua tem falso positivo medido. Ela mora em
// services/transferenciaPropria.js — a MESMA que a aba Transações usa pra
// sugerir ao cliente. Aqui só se formata o achado.
function transferenciasEntreContas(transacoes, wallets, ehTransferencia, opts) {
  const { paresTransferencia } = require('./transferenciaPropria');
  return paresTransferencia(transacoes, wallets, ehTransferencia, opts).map(({ grupo_id, saida: s, entrada: e }) => ({
    grupo_id, valor: cent(s.valor),
    detalhe: `${s.carteira_nome} → ${e.carteira_nome} em ${String(s.data).slice(0, 10)}: "${s.observacao || ''}" [${s.categoria}] / "${e.observacao || ''}" [${e.categoria}]`,
  }));
}

// ── 4. Previsto vencido há dias e nunca baixado ─────────────────────────────
// Pendente manual com data passada. Ou foi pago e ninguém marcou (o saldo
// previsto mente), ou é duplicata de algo que o banco já trouxe.
function previstosVencidos(transacoes, hoje, { diasTolerancia = 10 } = {}) {
  const corte = diaNum(hoje) - diasTolerancia;
  return (transacoes || [])
    .filter((t) => t && t.pago === false && !t.of_tx_id && !t.parcela_total
      && Number(t.valor) > 0 && diaNum(t.data) < corte)
    .map((t) => ({
      grupo_id: t.grupo_id, valor: cent(t.valor),
      detalhe: `"${t.observacao || ''}" (${t.tipo}, ${t.carteira_nome}) previsto pra ${String(t.data).slice(0, 10)}`,
    }));
}

// ── 5. Transação apontando pra conta que não existe (conta-fantasma) ───────
function transacoesOrfas(transacoes, wallets) {
  const nomes = new Set((wallets || []).map((w) => `${w.grupo_id}|${String(w.nome || '').trim().toLowerCase()}`));
  const achados = new Map();
  for (const t of transacoes || []) {
    if (!t || !t.carteira_nome) continue;
    const k = `${t.grupo_id}|${String(t.carteira_nome).trim().toLowerCase()}`;
    if (nomes.has(k)) continue;
    const a = achados.get(k) || { grupo_id: t.grupo_id, valor: 0, n: 0, nome: t.carteira_nome };
    a.valor += Number(t.valor) || 0; a.n++;
    achados.set(k, a);
  }
  return [...achados.values()].map((a) => ({
    grupo_id: a.grupo_id, valor: cent(a.valor), detalhe: `${a.n} lançamento(s) em "${a.nome}", que não é conta nenhuma`,
  }));
}

// ── 6. Conta/cartão preso a uma conexão que já foi encerrada ────────────────
function contasConexaoEncerrada(wallets, conexoes) {
  const vivas = new Set((conexoes || []).map((c) => c.external_id).filter(Boolean));
  return (wallets || [])
    .filter((w) => w && w.of_conta_id && w.of_consent_id && !vivas.has(w.of_consent_id))
    .map((w) => ({
      grupo_id: w.grupo_id, valor: cent(Math.abs(Number(w.saldo) || 0)),
      detalhe: `${ehCartao(w) ? 'cartão' : 'conta'} "${w.nome}" parou de atualizar (conexão encerrada)`,
    }));
}

// ── 7. Pagamento de fatura registrado em DOBRO ──────────────────────────────
// Mesmo cartão, competência, valor e dia. Hoje inofensivo na fatura publicada
// (vale o MAIOR), mas soma em dobro no ramo do ciclo.
function pagamentosFaturaDuplicados(pagamentos) {
  const vistos = new Map();
  for (const p of pagamentos || []) {
    if (!p) continue;
    const k = `${p.cartao_id}|${p.competencia}|${cent(p.valor)}|${String(p.data).slice(0, 10)}`;
    vistos.set(k, [...(vistos.get(k) || []), p]);
  }
  return [...vistos.values()].filter((l) => l.length > 1).map((l) => ({
    grupo_id: l[0].grupo_id, valor: cent(Number(l[0].valor) * (l.length - 1)),
    detalhe: `fatura ${l[0].competencia}: R$ ${cent(l[0].valor)} registrado ${l.length}× em ${String(l[0].data).slice(0, 10)}`,
  }));
}

// ── 8. Fatura VENCIDA ainda em aberto (pelo valor que a TELA mostra) ────────
// `faturas` = [{ grupo_id, cartao, competencia, venc, fatura, restante, fonte,
// pagoRegistrado }] já calculado com faturaVista. 'erro' quando o que a Sora
// registrou como pago COBRE A FATURA INTEIRA e mesmo assim ela aparece em
// aberto (regressão do caso Vander); 'atencao' no resto (pode ser atraso real).
// ⚠️ Compara com o TOTAL, nunca com o restante: fatura de 200 com 100 pagos tem
// restante 100 e pago 100 — "pago >= restante" a acusaria de paga.
function faturasVencidasAbertas(faturas, hoje) {
  const h = String(hoje).slice(0, 10);
  const erros = [], atencoes = [];
  for (const f of faturas || []) {
    if (!f || !(Number(f.restante) > 0.01) || !f.venc || f.venc >= h) continue;
    const item = {
      grupo_id: f.grupo_id, valor: cent(f.restante),
      detalhe: `${f.cartao} · fatura ${f.competencia} (R$ ${cent(f.fatura)}) venceu ${f.venc} · R$ ${cent(f.restante)} em aberto · pago registrado R$ ${cent(f.pagoRegistrado)} (${f.fonte})`,
    };
    if (Number(f.fatura) > 0.01 && Number(f.pagoRegistrado) >= Number(f.fatura) - 0.01) erros.push(item);
    else atencoes.push(item);
  }
  return { erros, atencoes };
}

/** Monta o relatório a partir dos achados de cada verificação. */
function montarRelatorio(verificacoes, emailDoGrupo = new Map()) {
  const checks = verificacoes.map(({ id, titulo, gravidade, explica, achados }) => {
    const grupos = new Set(achados.map((a) => a.grupo_id));
    return {
      id, titulo, gravidade, explica,
      total: achados.length,
      contas: grupos.size,
      valor: cent(achados.reduce((s, a) => s + (Number(a.valor) || 0), 0)),
      amostra: achados.slice(0, 40).map((a) => ({ ...a, email: emailDoGrupo.get(a.grupo_id) || null })),
    };
  });
  const ordem = { erro: 0, atencao: 1, sinal: 2 };
  checks.sort((a, b) => (ordem[a.gravidade] - ordem[b.gravidade]) || (b.total - a.total));
  return {
    checks,
    resumo: {
      erros: checks.filter((c) => c.gravidade === 'erro').reduce((s, c) => s + c.total, 0),
      atencoes: checks.filter((c) => c.gravidade === 'atencao').reduce((s, c) => s + c.total, 0),
      sinais: checks.filter((c) => c.gravidade === 'sinal').reduce((s, c) => s + c.total, 0),
    },
  };
}

/**
 * O que é NOVO desde o retrato anterior (pra quem abre o painel saber o que
 * apareceu hoje, sem reler a lista inteira). Chave = verificação + detalhe.
 */
function novidades(atual, anterior) {
  if (!anterior || !Array.isArray(anterior.checks)) return [];
  const antes = new Set();
  for (const c of anterior.checks) for (const a of c.amostra || []) antes.add(`${c.id}|${a.grupo_id}|${a.detalhe}`);
  const novos = [];
  for (const c of atual.checks) {
    for (const a of c.amostra || []) {
      if (!antes.has(`${c.id}|${a.grupo_id}|${a.detalhe}`)) novos.push({ check: c.id, gravidade: c.gravidade, ...a });
    }
  }
  return novos;
}

module.exports = {
  previstosConciliaveis, duplicatasConfirmadas, transferenciasEntreContas,
  previstosVencidos, transacoesOrfas, contasConexaoEncerrada,
  pagamentosFaturaDuplicados, faturasVencidasAbertas, montarRelatorio, novidades,
  cent,
};
