// ─────────────────────────────────────────────────────────────────────────────
// O RETRATO DOS WIDGETS — o que "Livre pra gastar", "Próximas contas" e
// "Cartão" mostram (fase 2, nov/2026).
//
// ⚠️ NENHUMA REGRA DE DINHEIRO NOVA. Cada número sai da mesma fonte do painel:
//   · "vai sobrar"   → aindaVemMes.js (cópia fiel do painel, com eval);
//   · faturas        → faturasDoGrupo.js (a rota da tela de cartões);
//   · contas a pagar → aPagarPeriodo.montarItens (o "o que tenho pra pagar" do zap);
//   · dívida atrasada → vencimentoDivida.parcelasEmAtraso (o card da dívida);
//   · gasto do mês   → resumoTransacoes.calcularResumo (o dashboard).
// Aqui só se escolhe o que vai pro widget e se escreve o texto.
//
// ⚠️ O TEXTO SAI PRONTO DAQUI ("Amanhã", "R$ 47", "Atrasada há 2 dias"). O
// widget do iPhone (Swift) e o do Android (Java) só desenham: regra escrita
// três vezes, em três linguagens, divergiria. Como o retrato é refeito a cada
// virada de dia, "amanhã" nunca fica velho mais que uma consulta.
//
// `montarResumo` é PURA (dados → retrato) pra o eval rodar sem banco;
// `lerDados` busca, só com as colunas que os widgets usam.
// ─────────────────────────────────────────────────────────────────────────────
const {
  previstosRestantesDoMes, pendentesDoCaixa, nomesDeCartao, itensDoSaldoProjetado, calcularSaldoProjetado,
} = require('./aindaVemMes');
const { montarItens, somarDias } = require('./aPagarPeriodo');
const { parcelasEmAtraso, hojeSP } = require('./vencimentoDivida');
const { formatar } = require('./moeda');

const FORMATO = 1;
// ⚠️ Suba quando um TEXTO do retrato mudar. Ele entra no ETag: sem isso o
// aparelho manda o ETag antigo, recebe 304 e fica com o texto velho até o dado
// da conta mudar. (2 = Livre diz se quem manda é o limite ou o caixa, nov/2026.)
// (3 = valor da fatura que não cabia no widget Android.)
const TEXTOS = 3;

// ⚠️ ANDROID ATÉ O BUILD 15: o widget do cartão escolhe a fonte pela QUANTIDADE
// de caracteres (até 11 → grande). "R$ 1.291,24" não cabia, o Android quebrava
// a linha no espaço e a tela mostrava só "R$". Preenchendo com um caractere
// INVISÍVEL e sem quebra (U+2060) até 14, o app instalado usa a fonte menor.
// No iPhone e no app novo (que mede a largura) não muda nada na tela.
const SEM_LARGURA = String.fromCharCode(0x2060);
const paraCaber = (txt) => (txt.length >= 11 ? txt.padEnd(14, SEM_LARGURA) : txt);
const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;
const SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const LETRAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function partes(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return { y, m, d };
}
const diaDaSemana = (iso) => { const { y, m, d } = partes(iso); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const diasEntre = (a, b) => {
  const pa = partes(a), pb = partes(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
};
const ddmm = (iso) => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}`;

/** "Hoje", "Amanhã", "Sexta, 21". */
function quando(data, hoje) {
  const n = diasEntre(hoje, data);
  if (n === 0) return 'Hoje';
  if (n === 1) return 'Amanhã';
  return `${SEMANA[diaDaSemana(data)]}, ${Number(String(data).slice(8, 10))}`;
}
function atrasoTexto(data, hoje) {
  const n = diasEntre(data, hoje);
  if (n <= 1) return 'Atrasada desde ontem';
  return `Atrasada há ${n} dias`;
}

/** Ícone da conta pelo nome (só os mais comuns; o resto usa o da origem). */
function iconeDaConta(titulo, origem) {
  if (origem === 'fatura') return 'cartao';
  if (origem === 'divida') return 'divida';
  const t = String(titulo || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\b(luz|energia|eletric|enel|cemig|copel|light|celesc|coelba|equatorial)/.test(t)) return 'luz';
  if (/\b(agua|saneamento|sabesp|copasa|cedae|sanepar|embasa)/.test(t)) return 'agua';
  if (/\b(internet|wi-?fi|fibra|vivo|claro|tim|oi)\b/.test(t)) return 'internet';
  if (/\b(aluguel|condominio|iptu|moradia)/.test(t)) return 'casa';
  return origem === 'agendado' ? 'agendado' : 'fixa';
}

/** Fatura na moeda do grupo — porte do `faturaNaBase` do painel. Sem câmbio fica fora. */
function faturaNaBase(f, base) {
  if (!f || f.moeda == null || f.moeda === base) return f;
  const taxa = Number(f.taxa_base);
  if (!Number.isFinite(taxa) || taxa <= 0) return null;
  const n = (v) => cent(Number(v) * taxa);
  const o = (v) => (typeof v === 'number' ? n(v) : v);
  return {
    ...f,
    fatura: o(f.fatura), pago: o(f.pago), restante: o(f.restante), total_previsto: o(f.total_previsto),
    vencida: f.vencida ? { ...f.vencida, restante: n(f.vencida.restante) } : f.vencida,
    proxima: f.proxima ? { ...f.proxima, restante: n(f.proxima.restante), fatura: o(f.proxima.fatura) } : f.proxima,
    atrasadas: (f.atrasadas || []).map((a) => ({ ...a, restante: n(a.restante) })),
    moeda: base,
  };
}

/** Formatadores na moeda do grupo. `inteiro` corta os centavos (pra "R$ 47 por dia"). */
function formatadores(base) {
  const fmt = (v) => formatar(v, base);
  const inteiro = (v) => fmt(Math.floor(Math.max(0, Number(v) || 0))).replace(/,\d{2}$/, '');
  const simbolo = fmt(0).replace(/\s*-?0,00$/, '').trim();
  return { fmt, inteiro, simbolo };
}

// ── Livre pra gastar ────────────────────────────────────────────────────────
function livre({ proj, gastosMes, metaMensal, hoje, fmts }) {
  const { y, m, d } = partes(hoje);
  const diasNoMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const diasRestantes = diasNoMes - d + 1;
  const fimMes = `${y}-${String(m).padStart(2, '0')}-${String(diasNoMes).padStart(2, '0')}`;

  // Com limite geral do mês, vale o MENOR: o que sobra no caixa ou o que
  // ainda cabe no limite. Sem limite, é o "vai sobrar" do painel.
  // ⚠️ O texto tem de dizer QUAL dos dois mandou: "−R$ 1.972 além do previsto"
  // com o caixa sobrando R$ 4.497 (era o limite estourado) não fez sentido pro
  // dono (nov/2026). `motivo` = 'limite' quando o limite é o menor.
  const caixa = cent(proj.projetado);
  const limite = Number(metaMensal) > 0 ? Number(metaMensal) : null;
  const noLimite = limite ? cent(limite - (Number(gastosMes) || 0)) : null;
  const motivo = noLimite != null && noLimite < caixa ? 'limite' : 'caixa';
  const disponivel = motivo === 'limite' ? noLimite : caixa;

  const gasto = Math.max(0, Number(gastosMes) || 0);
  // A MARÉ: do dinheiro livre do mês (o que já foi gasto + o que ainda sobra),
  // quanto ainda resta. A LINHA: quanto do mês ainda falta. Água acima da
  // linha = o dinheiro dura mais que o mês.
  const nivel = disponivel > 0 ? Math.min(1, disponivel / (disponivel + gasto || disponivel)) : 0;
  const ritmo = diasRestantes / diasNoMes;
  const porDia = disponivel / diasRestantes;

  let estado = 'folgado';
  if (disponivel < 0) estado = 'vermelho';
  else if (nivel + 0.02 < ritmo) estado = 'apertado';

  const base = {
    estado, nivel: Math.round(nivel * 1000) / 1000, ritmo: Math.round(ritmo * 1000) / 1000,
    aproximado: !!proj.aproximado, por_dia: cent(porDia), disponivel, dias_restantes: diasRestantes,
    // O "vai sobrar" da aba Previstos, sem o limite do mês (o eval compara com o painel).
    projetado: caixa,
    com_limite: !!limite,
    motivo,
  };
  const faltam = diasRestantes === 1 ? 'Último dia do mês' : `Faltam ${diasRestantes} dias no mês`;
  if (estado === 'vermelho') {
    // O número grande vai SEM sinal: quem explica é a linha de baixo, a cor e
    // o alerta ("−R$ 1.972 acima do limite" leria como sinal duplo).
    const numero = fmts.inteiro(Math.ceil(-disponivel)).replace(fmts.simbolo, '').trim();
    if (motivo === 'limite') {
      return {
        ...base,
        prefixo: fmts.simbolo, numero, sufixo: '', abaixo: 'acima do limite', status: 'Limite estourado',
        resto: `${fmts.inteiro(gasto)} de ${fmts.inteiro(limite)}`,
        resto_oculto: faltam,
      };
    }
    return {
      ...base,
      prefixo: fmts.simbolo, numero, sufixo: '', abaixo: 'vai faltar no mês', status: 'Revise os gastos',
      resto: faltam, resto_oculto: faltam,
    };
  }
  return {
    ...base,
    prefixo: fmts.simbolo, numero: fmts.inteiro(porDia).replace(fmts.simbolo, '').trim(),
    sufixo: 'por dia', abaixo: '', status: estado === 'apertado' ? 'Abaixo do ritmo' : 'No ritmo',
    resto: motivo === 'limite' ? `${fmts.inteiro(disponivel)} até o limite` : `${fmts.inteiro(disponivel)} até ${ddmm(fimMes)}`,
    resto_oculto: motivo === 'limite' ? `${fmts.simbolo} •••• até o limite` : `${fmts.simbolo} •••• até ${ddmm(fimMes)}`,
  };
}

// ── Próximas contas ─────────────────────────────────────────────────────────
function contas({ recorrencias, vinculadas, ajustes, pendentesTx, dividas, faturasBase, nomesCartao, hoje, fmts }) {
  const ate = somarDias(hoje, 6);
  const gastosFixos = (recorrencias || []).filter((r) => r.ativa !== false && (r.tipo || 'Gasto') === 'Gasto');
  const pendentesForaDoCartao = (pendentesTx || []).filter((t) =>
    !nomesCartao.has(String(t.carteira_nome || '').trim().toLowerCase()));

  // O que vence de hoje até daqui a 6 dias — a régua do "o que tenho pra pagar".
  const proximas = montarItens({
    recorrencias: gastosFixos, vinculadas, ajustes,
    pendentes: pendentesForaDoCartao,
    dividas: (dividas || []).filter((d) => ['ativa', 'em_atraso'].includes(d.status || 'ativa')),
    faturas: (faturasBase || []).map((f) => ({ nome: f.nome, venc: f.venc, restante: f.restante })),
  }, { de: hoje, ate }, hoje).map((i) => ({ ...i, atrasada: false }));

  // Atrasadas (só com prova): fatura vencida e não paga, parcela de dívida
  // vencida sem pagamento e lançamento pendente com data que já passou.
  // ⚠️ Conta fixa "atrasada" fica DE FORA de propósito: muita gente paga por
  // fora sem marcar, e o widget gritaria atraso de conta paga.
  const atrasadas = [];
  for (const f of faturasBase || []) {
    for (const a of f.atrasadas || []) {
      if (!(Number(a.restante) > 0.009) || !a.venc) continue;
      atrasadas.push({ data: a.venc, descricao: `Fatura ${f.nome}`, origem: 'fatura', valor: Number(a.restante), atrasada: true });
    }
  }
  for (const d of dividas || []) {
    if (!['ativa', 'em_atraso'].includes(d.status || 'ativa')) continue;
    if (d.of_id) {
      if (d.status === 'em_atraso') {
        atrasadas.push({ data: null, descricao: d.titulo || 'Dívida', origem: 'divida', valor: Number(d.valor_parcela) || null, atrasada: true, quantas: 1 });
      }
      continue;
    }
    const at = parcelasEmAtraso(d, hoje);
    if (!at) continue;
    atrasadas.push({
      data: at.desde, descricao: d.titulo || 'Dívida', origem: 'divida', atrasada: true, quantas: at.quantas,
      valor: Number(d.valor_parcela) > 0 ? cent(Number(d.valor_parcela) * at.quantas) : null,
    });
  }
  for (const t of pendentesForaDoCartao) {
    if (t.tipo !== 'Gasto' || t.pago || t.transferencia === true || t.ignorar_em) continue;
    if (/\b(fatura|transfer[eê]ncias?|ajuste)\b/i.test(String(t.categoria || ''))) continue;
    const d = String(t.data || '').slice(0, 10);
    if (!d || d >= hoje) continue;
    const desc = String(t.observacao || t.categoria || 'Gasto previsto')
      .replace(/^\[(Previsto|Recorrente)\]\s*/i, '').replace(/\p{Extended_Pictographic}/gu, '').trim();
    atrasadas.push({ data: d, descricao: desc || 'Gasto previsto', origem: 'agendado', valor: Number(t.valor) || null, atrasada: true });
  }
  atrasadas.sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')));

  const todas = [...atrasadas, ...proximas];
  const total = cent(todas.reduce((s, i) => s + (Number(i.valor) || 0), 0));

  const linha = (i) => ({
    titulo: i.descricao,
    sub: i.atrasada
      ? (i.quantas > 1 ? `${i.quantas} parcelas atrasadas` : (i.data ? atrasoTexto(i.data, hoje) : 'Em atraso'))
      : quando(i.data, hoje),
    valor: i.valor == null ? null : cent(i.valor),
    valor_txt: i.valor == null ? '' : fmts.fmt(i.valor),
    atrasada: !!i.atrasada,
    icone: iconeDaConta(i.descricao, i.origem),
    origem: i.origem,
  });

  const dias = Array.from({ length: 7 }, (_, k) => {
    const dia = somarDias(hoje, k);
    const doDia = proximas.filter((i) => i.data === dia);
    const ordem = ['fatura', 'divida', 'fixa', 'agendado'];
    const origem = doDia.length ? ordem.find((o) => doDia.some((i) => i.origem === o)) : null;
    return { letra: LETRAS[diaDaSemana(dia)], hoje: k === 0, origem };
  });

  return {
    quantidade: todas.length,
    rotulo: todas.length === 1 ? 'conta' : 'contas',
    total, total_txt: fmts.fmt(total),
    atrasadas: atrasadas.length,
    dias,
    itens: todas.slice(0, 3).map(linha),
    mais: Math.max(0, todas.length - 3),
  };
}

// ── Cartões ─────────────────────────────────────────────────────────────────
function cartoes({ faturas, hoje }) {
  return (faturas || []).map((f) => {
    const fmtC = (v) => formatar(v, f.moeda || 'BRL');
    // Fechou e foi paga: quem está viva é a seguinte (mesma regra da tela de cartões).
    const pulou = f.quitada && f.fechada && f.proxima;
    const valor = pulou ? f.proxima.restante : f.restante;
    const venc = pulou ? f.proxima.venc : f.venc;
    let sub;
    if (pulou) sub = `Vence ${ddmm(venc)}`;
    else if (!f.fechada) {
      const n = diasEntre(hoje, f.ultimo || f.fim);
      sub = n <= 0 ? `Fecha hoje · vence ${ddmm(venc)}` : `Fecha em ${n} ${n === 1 ? 'dia' : 'dias'} · vence ${ddmm(venc)}`;
    } else sub = Number(f.restante) > 0.009 ? `Fechada · vence ${ddmm(venc)}` : 'Fatura paga';
    const somaAtraso = cent((f.atrasadas || []).reduce((s, a) => s + (Number(a.restante) || 0), 0));
    return {
      id: f.cartao_id, nome: f.nome,
      valor: cent(valor), valor_txt: paraCaber(fmtC(valor || 0)),
      sub,
      atraso_txt: somaAtraso > 0.009 ? `${fmtC(somaAtraso)} em atraso` : '',
    };
  });
}

/**
 * Dados → retrato. PURA.
 * @param d { wallets, recorrencias, vinculadas, ajustes, dividas, faturas, pendentesTx, gastosMes, metaMensal, base }
 */
function montarResumo(d, { agora = new Date(), versao = '' } = {}) {
  const hoje = agora.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const base = d.base || 'BRL';
  const fmts = formatadores(base);

  const pessoais = (d.wallets || []).filter((w) => !w.da_empresa);
  const faturasBase = (d.faturas || []).map((f) => faturaNaBase(f, base)).filter(Boolean);
  const cartoesNomes = nomesDeCartao(d.wallets || []);

  // "Vai sobrar": a MESMA conta da aba Previstos (ver aindaVemMes.js).
  const restantes = previstosRestantesDoMes({ recorrencias: d.recorrencias, dividas: d.dividas, faturas: faturasBase, agora });
  // ⚠️ Só os pendentes DESTE mês entram no 'vai sobrar' (o painel lê o mês). A
  // busca vai até a semana que vem por causa das Próximas contas.
  const proxMes = (() => { const { y, m } = partes(hoje); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; })();
  const pendDoMes = (d.pendentesTx || []).filter((x) => String(x.data || '').slice(0, 10) < proxMes);
  const pend = pendentesDoCaixa(pendDoMes, cartoesNomes);
  const proj = calcularSaldoProjetado(
    pessoais.map((w) => ({ tipo: w.tipo, saldo: w.saldo_base ?? 0 })),
    itensDoSaldoProjetado(restantes, pend), [], agora,
  );

  return {
    formato: FORMATO,
    versao,
    hoje,
    gerado_em: agora.toISOString(),
    moeda: base,
    simbolo: fmts.simbolo,
    livre: livre({ proj, gastosMes: d.gastosMes, metaMensal: d.metaMensal, hoje, fmts }),
    contas: contas({
      recorrencias: d.recorrencias, vinculadas: d.vinculadas, ajustes: d.ajustes,
      pendentesTx: d.pendentesTx, dividas: d.dividas, faturasBase, nomesCartao: cartoesNomes, hoje, fmts,
    }),
    cartoes: cartoes({ faturas: d.faturas, hoje }),
  };
}

// ── Busca ───────────────────────────────────────────────────────────────────

/** Lê só o que os widgets usam. Mesmas fontes das telas (ver o cabeçalho). */
async function lerDados(grupoId, { metaMensal = null } = {}) {
  const supabase = require('../db/supabase');
  const { moedaBaseDoGrupo, comSaldoNaBase } = require('./moeda');
  const { marcarDaEmpresa } = require('./contaDaEmpresa');
  const { resolvidasNoMes } = require('./resolvidasNoMes');
  const { ultimoPagamentoPorDivida } = require('./vencimentoDivida');
  const { faturasDoGrupo } = require('./faturasDoGrupo');
  const { calcularResumo } = require('./resumoTransacoes');
  const arquivadas = require('./arquivadas');

  const hoje = hojeSP();
  const ym = hoje.slice(0, 7);
  const proxMes = (() => { const { y, m } = partes(hoje); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; })();

  const lerRecorrencias = async () => {
    const cols = 'id, tipo, categoria, valor, dia_vencimento, descricao, carteira, ativa, created_at';
    const c157 = 'frequencia, dia_semana, mes_vencimento, repeticoes, data_inicio, data_fim';
    const listar = (sel) => supabase.from('recorrencias').select(sel).eq('grupo_id', grupoId).eq('ativa', true);
    let { data, error } = await listar(`${cols}, valor_variavel, modo_lancamento, ${c157}`);
    if (error) ({ data, error } = await listar(`${cols}, valor_variavel, modo_lancamento`));
    if (error) ({ data, error } = await listar(`${cols}, valor_variavel`));
    if (error) ({ data, error } = await listar(cols));
    if (error) throw new Error(error.message);
    const resolvidas = await resolvidasNoMes(data || [], ym);
    return (data || []).map((r) => ({
      ...r, resolvida_no_mes: resolvidas.has(r.id), modo_lancamento: r.modo_lancamento || 'lancar',
      frequencia: r.frequencia || 'mensal',
    }));
  };

  const lerDividas = async () => {
    const cols = 'id, titulo, valor_parcela, dia_vencimento, status, nos_previstos, data_inicio, parcelas_total, parcelas_pagas, of_id';
    let { data, error } = await supabase.from('dividas').select(`${cols}, proximo_vencimento`).eq('grupo_id', grupoId);
    if (error) ({ data, error } = await supabase.from('dividas').select(cols).eq('grupo_id', grupoId));
    if (error) throw new Error(error.message);
    const ult = await ultimoPagamentoPorDivida((data || []).map((x) => x.id));
    return (data || []).map((x) => ({ ...x, ultimo_pagamento: ult[x.id] || null }));
  };

  const lerWallets = async () => {
    const { data, error } = await supabase.from('wallets')
      .select('id, nome, tipo, saldo, moeda, of_conta_id, arquivada').eq('grupo_id', grupoId);
    if (error) throw new Error(error.message);
    const base = await moedaBaseDoGrupo(grupoId);
    return { base, wallets: await comSaldoNaBase(await marcarDaEmpresa(data || []), base) };
  };

  // Do dia 1 até o fim da semana que vem (o que for mais longe).
  const ateBusca = [proxMes, somarDias(hoje, 7)].sort().pop();
  const lerPendentes = async () => {
    let q = supabase.from('transacoes')
      .select('tipo, valor, pago, carteira_nome, transferencia, data, observacao, categoria, ignorar_em')
      .eq('grupo_id', grupoId).eq('pago', false)
      .gte('data', `${ym}-01`).lt('data', ateBusca).limit(500);
    q = await arquivadas.filtrar(q, {});
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  };

  // Contas fixas já ligadas a um lançamento e ajustes (pulada/adiada) — o que
  // o `montarItens` precisa pra não cobrar de novo o que já foi resolvido.
  const lerVinculosEAjustes = async () => {
    const [vinc, ajs] = await Promise.all([
      supabase.from('transacoes').select('recorrencia_id, competencia')
        .eq('grupo_id', grupoId).not('recorrencia_id', 'is', null)
        .gte('competencia', ym).lte('competencia', somarDias(hoje, 6).slice(0, 7))
        .then((r) => r, () => ({ data: [] })),
      supabase.from('previsao_ajustes').select('recorrencia_id, competencia, status, nova_data, novo_valor')
        .eq('grupo_id', grupoId)
        .then((r) => r, () => ({ data: [] })),
    ]);
    return { vinculadas: vinc.data || [], ajustes: ajs.data || [] };
  };

  const [w, recorrencias, dividas, faturas, pendentesTx, va, resumo] = await Promise.all([
    lerWallets(), lerRecorrencias(), lerDividas(), faturasDoGrupo(grupoId, { offset: 0 }),
    lerPendentes(), lerVinculosEAjustes(), calcularResumo({ grupoId, mes: ym }),
  ]);

  return {
    base: w.base, wallets: w.wallets, recorrencias, dividas, faturas, pendentesTx,
    vinculadas: va.vinculadas, ajustes: va.ajustes,
    gastosMes: resumo ? resumo.gastos : 0, metaMensal,
  };
}

module.exports = { montarResumo, lerDados, faturaNaBase, quando, atrasoTexto, iconeDaConta, FORMATO, TEXTOS };
