// =============================================================================
// COLETA do diagnóstico financeiro — a ÚNICA parte que lê o banco.
//
// As verificações (services/diagnosticoFinanceiro.js) são puras e testadas;
// aqui só se busca o que elas precisam e se chama a fonte única de cada número
// (faturaVista pra fatura, ehTransferencia pra totais). Só LÊ, nunca grava em
// tabela de cliente — o único insert é o retrato em `diagnostico_financeiro`
// (migration 186), e ele é tolerante: sem a tabela, o relatório sai igual.
//
// ⚠️ EGRESS: o custo do Supabase é o NÚMERO de idas (ver CLAUDE.md). Transações
// vêm em páginas de 1.000 numa janela de 60 dias (medido: 120 dias liam ~34 mil linhas, ~13 MB por rodada); fatura é calculada só pros
// 2 ciclos já vencidos de cada cartão. Medido: ~1% das requisições do dia.
// =============================================================================
const supabase = require('../db/supabase');
const D = require('./diagnosticoFinanceiro');

const COLS_TX = 'id, id_curto, grupo_id, valor, valor_moeda, tipo, observacao, categoria, carteira_nome, data, created_at, of_tx_id, pluggy_tx_id, parcela_total, recorrente, transferencia, pago, ignorar_em';

function somaDias(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function paginado(montar) {
  let out = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await montar().range(o, o + 999);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Faturas dos 2 ciclos JÁ VENCIDOS de cada cartão, pelo valor que a tela mostra. */
async function faturasVencidas(cartoes, pagamentos) {
  const { statusFatura } = require('./faturaRollover');
  const { valorExibido } = require('./faturaVista');
  const { competenciaAtual, competenciaVizinha } = require('./cicloFatura');
  const pagoReg = new Map();
  for (const p of pagamentos) {
    const k = `${p.cartao_id}|${p.competencia}`;
    pagoReg.set(k, (pagoReg.get(k) || 0) + (Number(p.valor) || 0));
  }
  const out = [];
  for (const c of cartoes) {
    if (!c.dia_vencimento) continue;            // sem ciclo não há "vencida"
    let atual;
    try { atual = competenciaAtual(c); } catch { continue; }
    for (const passo of [-1, -2]) {
      try {
        const comp = competenciaVizinha(c, atual, passo);
        const st = await statusFatura(c.grupo_id, c, comp);
        const v = await valorExibido(c, comp, st, {});
        out.push({
          grupo_id: c.grupo_id, cartao: c.nome, competencia: comp,
          venc: st.ciclo && st.ciclo.venc, fatura: v.fatura, restante: v.restante, fonte: v.fonte,
          pagoRegistrado: pagoReg.get(`${c.id}|${comp}`) || 0,
        });
      } catch { /* um cartão com dado ruim não derruba a varredura */ }
    }
  }
  return out;
}

/**
 * Roda a varredura inteira. `grupoId` opcional restringe a uma conta.
 * @returns {{ geradoEm, checks, resumo, novidades }}
 */
async function rodarDiagnostico({ grupoId = null, salvar = false } = {}) {
  const { hojeSP } = require('./cicloFatura');
  const { ehTransferencia } = require('./resumoTransacoes');
  const { ehDuplicata } = require('./duplicadas');
  const hoje = hojeSP();
  const desde = somaDias(hoje, -60);
  const soGrupo = (q) => (grupoId ? q.eq('grupo_id', grupoId) : q);

  // ⚠️ `ignorar_em` (146) é pedida com rede: sem a coluna o select INTEIRO
  // falharia e a varredura voltaria vazia — dizendo "tudo certo" sem ter olhado.
  let txs;
  try {
    txs = await paginado(() => soGrupo(supabase.from('transacoes').select(COLS_TX))
      .gte('data', desde).lte('data', `${somaDias(hoje, 1)}T23:59:59`).order('id'));
  } catch (e) {
    if (!/ignorar_em/i.test(e.message || '')) throw e;
    txs = await paginado(() => soGrupo(supabase.from('transacoes').select(COLS_TX.replace(', ignorar_em', '')))
      .gte('data', desde).lte('data', `${somaDias(hoje, 1)}T23:59:59`).order('id'));
  }
  const wallets = await paginado(() => soGrupo(supabase.from('wallets')
    .select('id, grupo_id, nome, tipo, saldo, of_conta_id, of_consent_id, dia_fechamento, dia_vencimento, of_limite_usado, moeda')).order('id'));
  const { data: conexoes } = await supabase.from('of_conexoes').select('external_id, grupo_id');
  const pagamentos = await paginado(() => soGrupo(supabase.from('pagamentos_fatura')
    .select('grupo_id, cartao_id, competencia, valor, data, transacao_id')).gte('data', somaDias(hoje, -180)).order('id'));

  const cartoes = wallets.filter((w) => /cr[eé]dito/i.test(w.tipo || ''));
  // ⚠️ Fatura é a parte cara (~4 idas por ciclo). Só entra cartão com MOVIMENTO
  // na janela (lançamento ou pagamento registrado): cartão parado não tem fatura
  // vencida a acusar, e era a maioria das ~2.900 idas da 1ª medição.
  const comMovimento = new Set(txs.map((t) => `${t.grupo_id}|${String(t.carteira_nome || '').trim().toLowerCase()}`));
  const comPagamento = new Set(pagamentos.map((p) => p.cartao_id));
  const ativos = cartoes.filter((c) => comPagamento.has(c.id)
    || comMovimento.has(`${c.grupo_id}|${String(c.nome || '').trim().toLowerCase()}`));
  const faturas = await faturasVencidas(ativos, pagamentos);
  const fv = D.faturasVencidasAbertas(faturas, hoje);

  const verificacoes = [
    { id: 'fatura_paga_em_aberto', gravidade: 'erro', titulo: 'Fatura paga aparecendo em aberto',
      explica: 'A Sora tem o pagamento registrado e mesmo assim mostra a fatura vencida em aberto (o caso Vander). Tem de ser zero.',
      achados: fv.erros },
    { id: 'previsto_conciliavel', gravidade: 'erro', titulo: 'Lançamento manual convivendo com a cobrança igual do banco',
      explica: 'Mesmo valor, conta e dia — conta em dobro até alguém juntar. O sync deveria absorver e o painel oferece "Conciliar".',
      achados: D.previstosConciliaveis(txs, (p, c) => ehDuplicata(p, c) === 'manual-e-banco',
        { contasDoBanco: new Set(wallets.filter((w) => w.of_conta_id).map((w) => `${w.grupo_id}|${w.nome}`)) }) },
    { id: 'duplicata_confirmada', gravidade: 'erro', titulo: 'Lançamento duplicado (com prova)',
      explica: 'O que o Detetive Watson afirma: mesmo instante, ou manual × banco. Valor = o que sobra contado a mais.',
      achados: D.duplicatasConfirmadas(txs) },
    { id: 'transacao_orfa', gravidade: 'erro', titulo: 'Lançamento em conta que não existe',
      explica: 'Conta-fantasma: some do extrato e de todo filtro por conta.',
      achados: D.transacoesOrfas(txs, wallets) },
    { id: 'fatura_vencida_aberta', gravidade: 'atencao', titulo: 'Fatura vencida ainda em aberto',
      explica: 'Pode ser atraso de verdade — ou pagamento que não chegou como transação (débito em outra conta).',
      achados: fv.atencoes },
    { id: 'previsto_vencido', gravidade: 'atencao', titulo: 'Previsto vencido há mais de 10 dias',
      explica: 'Foi pago e ninguém deu baixa (o saldo previsto mente) ou é cópia de algo que o banco já trouxe.',
      achados: D.previstosVencidos(txs, hoje) },
    { id: 'conexao_encerrada', gravidade: 'atencao', titulo: 'Conta/cartão preso a conexão encerrada',
      explica: 'Parou de atualizar e segue exibindo o último valor.',
      achados: D.contasConexaoEncerrada(wallets, grupoId ? (conexoes || []).filter((c) => c.grupo_id === grupoId) : conexoes) },
    { id: 'pagamento_fatura_duplicado', gravidade: 'atencao', titulo: 'Pagamento de fatura registrado em dobro',
      explica: 'Mesmo cartão, fatura, valor e dia. Inofensivo na fatura publicada; soma em dobro no ciclo.',
      achados: D.pagamentosFaturaDuplicados(pagamentos) },
    { id: 'transferencia_entre_contas', gravidade: 'sinal', titulo: 'Possível transferência entre contas próprias',
      explica: 'Saída numa conta e entrada noutra, mesmo valor, até 1 dia — conta como gasto E receita. Tem falso positivo conhecido: só indica.',
      achados: D.transferenciasEntreContas(txs, wallets, ehTransferencia) },
  ];

  // E-mail de cada grupo (dono), só pra o relatório ser lido por gente.
  const grupos = [...new Set(verificacoes.flatMap((v) => v.achados.map((a) => a.grupo_id)))];
  const emailDoGrupo = new Map();
  for (let i = 0; i < grupos.length; i += 200) {
    const { data } = await supabase.from('users').select('email, grupo_ativo').in('grupo_ativo', grupos.slice(i, i + 200));
    for (const u of data || []) if (u.grupo_ativo && !emailDoGrupo.has(u.grupo_ativo)) emailDoGrupo.set(u.grupo_ativo, u.email);
  }

  const escopo = { grupoId, desde, transacoes: txs.length, cartoes: cartoes.length, cartoesAvaliados: ativos.length };
  const rel = { ...D.montarRelatorio(verificacoes, emailDoGrupo), escopo };
  const geradoEm = new Date().toISOString();

  // Novidades vs o último retrato + grava este (só a varredura da base inteira).
  let novidades = [];
  if (!grupoId) {
    try {
      const { data: ult } = await supabase.from('diagnostico_financeiro')
        .select('relatorio').order('gerado_em', { ascending: false }).limit(1).maybeSingle();
      novidades = D.novidades(rel, ult && ult.relatorio);
      if (salvar) {
        await supabase.from('diagnostico_financeiro').insert({ gerado_em: geradoEm, resumo: rel.resumo, relatorio: rel });
      }
    } catch { /* migration 186 pendente: relatório sai igual, sem histórico */ }
  }

  return { geradoEm, hoje, ...rel, novidades };
}

// ── Execução em SEGUNDO PLANO ───────────────────────────────────────────────
// A varredura da base leva minutos (medido: ~5 min, ~2.000 idas). Nenhuma
// chamada HTTP espera isso (a Vercel corta em 60s), então o painel DISPARA e
// depois LÊ o último retrato salvo. Uma rodada por vez: o cron e o botão do
// painel não podem empilhar duas varreduras de 5 minutos.
let rodando = null;   // { desde: ISO, origem } enquanto roda

function emAndamento() { return rodando; }

function dispararDiagnostico(origem = 'manual') {
  if (rodando) return { iniciado: false, rodando };
  rodando = { desde: new Date().toISOString(), origem };
  rodarDiagnostico({ salvar: true })
    .then((r) => console.log(`🩺 Diagnóstico financeiro (${origem}): ${r.resumo.erros} erro(s), ${r.resumo.atencoes} atenção, ${r.resumo.sinais} sinal(is) · ${r.novidades.length} novidade(s)`))
    .catch((e) => console.error('🩺 Diagnóstico financeiro falhou:', e && e.message ? e.message : e))
    .finally(() => { rodando = null; });
  return { iniciado: true, rodando };
}

/** Último retrato salvo (migration 186). `null` sem a tabela ou sem retrato. */
async function ultimoRetrato() {
  try {
    const { data, error } = await supabase.from('diagnostico_financeiro')
      .select('gerado_em, relatorio').order('gerado_em', { ascending: false }).limit(2);
    if (error || !data || !data.length) return null;
    const [atual, anterior] = data;
    return {
      ...atual.relatorio, geradoEm: atual.gerado_em,
      novidades: D.novidades(atual.relatorio, anterior && anterior.relatorio),
    };
  } catch { return null; }
}

module.exports = { rodarDiagnostico, dispararDiagnostico, emAndamento, ultimoRetrato };
