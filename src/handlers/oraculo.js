// =============================================================================
// AGENTE ORÁCULO — "posso comprar isso?" respondido no WhatsApp.
//
// Lê a foto financeira do grupo, chama a aritmética canônica
// (services/saudeCompra) e responde com a arte do agente.
//
// ⚠️ ESTE ARQUIVO NÃO DECIDE NADA. Toda regra de "pode/não pode" mora em
// services/saudeCompra.js, que é puro e tem eval. Aqui é só busca no banco +
// texto. Duplicar um pedaço da regra aqui criaria uma segunda verdade, e a
// primeira vez que alguém mudar o critério as duas divergem em silêncio.
//
// Gate: Premium e Platinum. O Oráculo depende da foto completa (Open Finance,
// OFX, cartões, recorrências) — no Básico ele cairia em "não sei" quase sempre,
// o que leria como função quebrada.
// =============================================================================
const supabase = require('../db/supabase');
const { enviarTexto, enviarImagem } = require('../services/mensageiro');
const { interpretarCompra } = require('../services/compraTexto');
const { avaliarCompra, calcularRenda, calcularSaida } = require('../services/saudeCompra');
const { capaDe } = require('../agentes');
const { normalizarPlano } = require('../config/planos');
const { competenciaAtual, cicloPorCompetencia, competenciaVizinha } = require('../services/cicloFatura');

const PLANOS_ORACULO = ['premium', 'platinum'];

/** Teto da legenda de imagem no WhatsApp Cloud API (services/whatsapp.js). */
const MAX_LEGENDA = 1000;

const cent = (v) => Math.round((Number(v) || 0) * 100);
const fmt = (c) => new Intl.NumberFormat('pt-BR',
  { style: 'currency', currency: 'BRL' }).format((Number(c) || 0) / 100);
const pct = (f) => `${Math.round((Number(f) || 0) * 100)}%`;

const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** 'YYYY-MM' de N meses atrás a partir de hoje (SP). */
function ymAtras(n) {
  const [Y, M] = hojeSP().split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEITURA DA FOTO FINANCEIRA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monta tudo o que a aritmética precisa, em POUCAS queries.
 *
 * ⚠️ A resposta é síncrona no WhatsApp e o Render é free tier. Por isso a
 * fatura é apurada só da competência ATUAL de cada cartão (é o que o limite
 * precisa) — varrer competência a competência é justamente o custo que o
 * agendaFeed evitou de propósito.
 */
async function lerFoto(grupoId) {
  const hoje = hojeSP();

  const [wRes, rRes, dRes] = await Promise.all([
    supabase.from('wallets')
      .select('id, nome, tipo, saldo, limite, dia_fechamento, dia_vencimento, of_conta_id, arquivada')
      .eq('grupo_id', grupoId),
    supabase.from('recorrencias')
      .select('tipo, valor, carteira, modo_lancamento, valor_variavel')
      .eq('grupo_id', grupoId).eq('ativa', true),
    supabase.from('dividas')
      .select('id, titulo, valor_parcela, parcelas_total, parcelas_pagas, dia_vencimento, status, nos_previstos')
      .eq('grupo_id', grupoId),
  ]);

  const wallets = (wRes.data || []).filter((w) => !w.arquivada);
  const recs    = rRes.data || [];
  const dividas = (dRes.data || []).filter((d) => d.status !== 'quitada');

  // ── Caixa: só o que é dinheiro disponível ────────────────────────────────
  // ⚠️ Carteira de crédito fica FORA. O saldo dela representa a FATURA
  // (negativo por definição no Open Finance), não dinheiro — somá-la ao caixa
  // misturaria dívida com disponibilidade. Mesma regra do lib/saldo-projetado.
  const caixa = wallets
    .filter((w) => w.tipo !== 'Crédito')
    .reduce((s, w) => s + cent(w.saldo), 0);

  // ── Renda e despesa fixas ────────────────────────────────────────────────
  // ⚠️ `tipo` é 'Gasto'/'Recebimento' (medido: 289/95 na base). Comparar com
  // 'receita' — como o agendaFeed fazia — trata TODA receita como despesa.
  const recReceita = recs.filter((r) => r.tipo === 'Recebimento');
  const recGasto   = recs.filter((r) => r.tipo === 'Gasto');

  // ── Parcelas de dívida que ainda vão vencer ──────────────────────────────
  // `nos_previstos === false` = o usuário tirou essa dívida da projeção
  // (migration 115). Respeitar isso aqui é o mesmo que o painel faz.
  const parcelaDividas = dividas
    .filter((d) => d.nos_previstos !== false)
    .filter((d) => (d.parcelas_total || 0) === 0 || (d.parcelas_pagas || 0) < d.parcelas_total)
    .reduce((s, d) => s + cent(d.valor_parcela), 0);

  // ── Cartões: fatura em aberto + parcelas já comprometidas ────────────────
  const cartoes = [];
  let parcelasFuturasTotal = 0;
  let faturasEmDia = null;

  for (const w of wallets.filter((x) => x.tipo === 'Crédito')) {
    let faturaAberta = 0;
    let vencida = false;
    try {
      const { statusFatura } = require('../services/faturaRollover');
      const { valorExibido } = require('../services/faturaVista');
      const { lerPrevistas } = require('../services/parcelasPrevistas');
      const comp = competenciaAtual(w);
      const st = await statusFatura(grupoId, w, comp);
      // A MESMA dep da rota de faturas e da agenda — fonte única do valor.
      const vista = await valorExibido(w, comp, st, { parcelasPrevistas: lerPrevistas });
      faturaAberta = cent(vista.restante);
      try {
        const ciclo = cicloPorCompetencia(w, comp);
        vencida = !vista.quitada && ciclo.venc < hoje;
      } catch { /* sem ciclo não dá pra dizer que venceu */ }
      faturasEmDia = (faturasEmDia === false) ? false : !vencida;
    } catch { /* tolerante: sem a fatura o cartão ainda serve pro limite */ }

    // Parcelas futuras já comprometidas neste cartão (as que o banco conhece).
    let previstas = 0;
    try {
      const comp = competenciaAtual(w);
      const de = competenciaVizinha(w, comp, 1);
      const { data } = await supabase.from('of_parcelas_previstas')
        .select('valor, competencia').eq('cartao_id', w.id).gte('competencia', de);
      previstas = (data || []).reduce((s, p) => s + cent(p.valor), 0);
    } catch { /* migration 116 pode não ter rodado — projeção é opcional */ }

    parcelasFuturasTotal += previstas;
    cartoes.push({
      id: w.id, nome: w.nome, limite: cent(w.limite),
      faturaAberta, parcelasFuturas: previstas,
    });
  }

  // ── Histórico: 3 meses FECHADOS ──────────────────────────────────────────
  // O mês corrente fica de fora: está pela metade e puxaria os dois lados
  // (renda e gasto) pra baixo sem significar nada.
  const desde = `${ymAtras(3)}-01`;
  const ate   = `${ymAtras(0)}-01`;
  const { data: txs } = await supabase.from('transacoes')
    .select('tipo, valor, data, transferencia')
    .eq('grupo_id', grupoId).gte('data', desde).lt('data', ate);

  const porMes = {};
  for (const t of txs || []) {
    if (t.transferencia) continue;             // transferência não é renda nem gasto
    const ym = String(t.data).slice(0, 7);
    porMes[ym] = porMes[ym] || { receita: 0, gasto: 0 };
    if (t.tipo === 'Recebimento') porMes[ym].receita += cent(t.valor);
    else if (t.tipo === 'Gasto')  porMes[ym].gasto   += cent(t.valor);
  }
  const meses = Object.keys(porMes).sort();
  const receitaPorMes = meses.map((m) => porMes[m].receita);
  const gastoPorMes   = meses.map((m) => porMes[m].gasto);

  const { mediana } = require('../services/saudeCompra');
  const gastoMediano = gastoPorMes.length >= 3 ? mediana(gastoPorMes) : 0;

  return {
    caixa,
    renda: calcularRenda(recReceita, receitaPorMes),
    saida: calcularSaida(
      recGasto.reduce((s, r) => s + cent(r.valor), 0) + parcelaDividas,
      gastoMediano,
    ),
    cartoes,
    parcelasFuturasTotal,
    faturasEmDia,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXTO
// ─────────────────────────────────────────────────────────────────────────────

const TITULO = {
  pode:    '🔮 *Pode comprar.*',
  cuidado: '🔮 *Cabe — mas aperta.*',
  nao:     '🔮 *Melhor não agora.*',
};

/** Um marcador por linha, só com o que foi medido (ver montarMotivos). */
function linhaMotivo(m) {
  switch (m.chave) {
    case 'caixa':
      return `• Caixa hoje: ${fmt(m.valor)}`;
    case 'limite':
      return m.bom
        ? `• Limite disponível: ${fmt(m.valor)}${m.limite ? ` de ${fmt(m.limite)}` : ''}`
        : `• ⚠️ Limite não cobre: ${fmt(m.valor)} livres${m.nome ? ` no ${m.nome}` : ''}`;
    case 'faturas':
      return m.bom ? '• Faturas em dia' : '• ⚠️ Você tem fatura vencida em aberto';
    case 'renda':
      // ⚠️ "Renda estável" SÓ quando a oscilação medida é baixa. Imprimir isso
      // pra quem varia 56% é afirmar algo que a Sora não verificou.
      if (m.fonte === 'fixa') return `• Renda cadastrada: ${fmt(m.valor)}/mês`;
      return m.bom
        ? `• Renda estável: ${fmt(m.valor)}/mês (variou ${pct(m.variacao)} em 3 meses)`
        : `• Renda variável: usei o mês mais fraco, ${fmt(m.valor)} (oscilou ${pct(m.variacao)})`;
    case 'saida':
      return `• Sai por mês: ${fmt(m.valor)}`;
    default:
      return null;
  }
}

function descreverCompra(c) {
  const alvo = c.item ? `${c.item} ` : '';
  return c.parcelas > 1
    ? `${alvo}em ${c.parcelas}x de ${fmt(c.parcela)} (${fmt(c.total)})`
    : `${alvo}de ${fmt(c.total)}`;
}

function montarMensagem(compra, r) {
  const linhas = [];

  // ── Sem veredito: prova o que sabe e pede o que falta ────────────────────
  if (r.tier !== 'veredito') {
    linhas.push('🔮 *Ainda não posso cravar isso.*', '');
    const motivos = r.motivos.map(linhaMotivo).filter(Boolean);
    if (motivos.length) {
      linhas.push('*O que eu já sei:*', ...motivos, '');
    }
    if (r.faltando.includes('renda')) {
      linhas.push(
        'Pra dizer se _' + descreverCompra(compra) + '_ cabe, preciso saber quanto entra por mês.',
        '',
        'Me diga assim: *"recebo 5000 todo dia 5"* — aí eu respondo na hora. 🔮',
      );
    } else if (r.faltando.includes('despesas')) {
      linhas.push('Preciso conhecer seus gastos fixos. Cadastre-os no painel ou me diga: *"todo dia 10 pago 800 de aluguel"*.');
    } else {
      linhas.push('Me mande mais alguns lançamentos que eu consigo responder.');
    }
    return linhas.join('\n');
  }

  // ── Veredito ─────────────────────────────────────────────────────────────
  linhas.push(TITULO[r.veredito], '');
  linhas.push('*Por quê?*');
  for (const m of r.motivos) { const l = linhaMotivo(m); if (l) linhas.push(l); }
  linhas.push('');
  linhas.push('*Minha recomendação:*');

  const n = r.numeros;
  const alvo = descreverCompra(compra);

  if (r.veredito === 'pode') {
    linhas.push(
      `${alvo.charAt(0).toUpperCase()}${alvo.slice(1)} cabe. `
      + (n.ocupacao != null
        ? `A parcela ocupa ${pct(n.ocupacao)} da sua folga de ${fmt(n.folga)} por mês`
        : `Sobra ${fmt(n.folga)} por mês`)
      + (compra.parcelas > 1 ? ` e todo mês do parcelamento fecha no positivo.` : '.')
      + ' 💪',
    );
  } else if (r.veredito === 'cuidado') {
    const porques = [];
    if (r.regras && !r.regras.ocupacao && n.ocupacao != null) {
      porques.push(`a parcela come ${pct(n.ocupacao)} da sua folga de ${fmt(n.folga)}`);
    }
    if (r.regras && !r.regras.reserva) {
      porques.push(`o caixa fica abaixo de um mês de despesa (${fmt(n.reservaAlvo)})`);
    }
    if (r.regras && !r.regras.faturasEmDia) {
      porques.push('você tem fatura vencida em aberto — quitar isso antes sai mais barato que qualquer parcela');
    }
    linhas.push(
      `${alvo.charAt(0).toUpperCase()}${alvo.slice(1)} cabe no papel, mas `
      + (porques.join(' e ') || 'sem folga pra imprevisto')
      + '. Se puder esperar ou dar uma entrada, você compra sem apertar.',
    );
  } else {
    const porques = [];
    if (r.regras && !r.regras.cartao) {
      porques.push(`o limite disponível é ${fmt(n.limiteDisponivel)} e a compra trava ${fmt(n.total)} de uma vez (parcelado ocupa o limite inteiro)`);
    }
    if (r.regras && !r.regras.todoMesPositivo) {
      porques.push(n.folga <= 0
        ? `hoje seus gastos já consomem tudo que entra (${fmt(n.saida)} de ${fmt(n.renda)})`
        : `a parcela de ${fmt(n.parcela)} é maior que sua folga de ${fmt(n.folga)}`);
    }
    linhas.push(`Não dá: ${porques.join('; ')}.`);
    if (n.folga > 0 && compra.parcelas > 1) {
      const cabe = Math.floor(n.folga * 0.30 / 100) * 100;
      if (cabe > 0) linhas.push('', `Uma parcela de até ${fmt(cabe)} caberia com folga.`);
    }
  }

  return linhas.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRADA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tenta atender a pergunta. Devolve `true` se respondeu (webhook para aqui).
 */
async function capturaOraculo(mensagem, ctx) {
  const compra = interpretarCompra(mensagem);
  if (!compra) return false;

  const { phone, user } = ctx;

  if (!PLANOS_ORACULO.includes(normalizarPlano(user && user.plano))) {
    await enviarTexto(phone,
      '🔮 O *Oráculo* diz se uma compra cabe no seu bolso antes de você assumi-la — '
      + 'cruzando fatura, limite, contas fixas e o que entra por mês.\n\n'
      + 'Ele faz parte dos planos *Premium* e *Platinum*: forsora.com/planos');
    return true;
  }

  let foto;
  try {
    foto = await lerFoto(user.grupo_ativo);
  } catch (e) {
    console.error('🔮 oráculo — falha ao ler a foto:', e.message);
    // ⚠️ Silêncio aqui seria pior que o erro: a pessoa fica esperando resposta
    // pra uma decisão de compra. E NUNCA chutar um veredito nesse caminho.
    await enviarTexto(phone, '🔮 Não consegui consultar suas contas agora. Tenta de novo em instantes?');
    return true;
  }

  // Escolhe o cartão com mais limite livre — é o que a pessoa usaria.
  const cartao = (foto.cartoes || [])
    .filter((c) => c.limite > 0)
    .sort((a, b) => (b.limite - b.faturaAberta - b.parcelasFuturas)
                  - (a.limite - a.faturaAberta - a.parcelasFuturas))[0] || null;

  const r = avaliarCompra(compra, {
    renda: foto.renda,
    saida: foto.saida,
    caixa: foto.caixa,
    cartao,
    faturasEmDia: foto.faturasEmDia,
  });

  const texto = montarMensagem(compra, r);

  // ⚠️ A legenda de imagem é cortada em 1024 caracteres. Deixar a explicação
  // ser truncada no meio de um número é pior que mandar duas mensagens.
  if (texto.length <= MAX_LEGENDA) {
    await enviarImagem(phone, capaDe('oraculo'), texto);
  } else {
    const corte = texto.indexOf('\n\n');
    await enviarImagem(phone, capaDe('oraculo'), corte > 0 ? texto.slice(0, corte) : TITULO[r.veredito] || '🔮');
    await enviarTexto(phone, corte > 0 ? texto.slice(corte + 2) : texto);
  }
  return true;
}

module.exports = { capturaOraculo, lerFoto, montarMensagem, linhaMotivo };
