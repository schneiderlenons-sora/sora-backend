/**
 * Engine de Insights de Negócios.
 *
 * Combina regras determinísticas (variação % mês a mês, etc.) com geração
 * opcional via Claude pra texto natural. Roda no cron diário e on-demand.
 *
 * Filosofia: insights são SÓBRIOS e DIRETOS — sem emoji, sem hype.
 * "Seu CAC subiu 31%. Isso pode comer sua margem em junho."
 */
const supabase = require('../db/supabase');
const OpenAI = require('openai');

const fmt = (centavos) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((centavos || 0) / 100);

/**
 * Gera insights para um usuário a partir do estado atual.
 * Retorna lista de insights criados (não persiste duplicatas no mesmo dia).
 */
async function gerarInsights(userId, grupoId) {
  // 1. Carrega snapshots dos últimos 2 meses
  const hoje = new Date();
  const periodoAtual = hoje.toISOString().slice(0, 7) + '-01';
  const dAnt = new Date(hoje); dAnt.setMonth(dAnt.getMonth() - 1);
  const periodoAnt = dAnt.toISOString().slice(0, 7) + '-01';

  const { data: snapAtual } = await supabase
    .from('dre_snapshots').select('*').eq('user_id', userId).eq('periodo', periodoAtual).maybeSingle();
  const { data: snapAnt } = await supabase
    .from('dre_snapshots').select('*').eq('user_id', userId).eq('periodo', periodoAnt).maybeSingle();

  if (!snapAtual || snapAtual.total_vendas === 0) {
    return []; // sem dados, nada pra analisar
  }

  // 2. Config (pra checar se IA está ligada)
  const { data: cfg } = await supabase
    .from('config_negocio').select('*').eq('user_id', userId).maybeSingle();
  const usarClaude = cfg?.ai_insights_ativo !== false && !!process.env.OPENAI_API_KEY;

  const insights = [];

  // ─── REGRAS DETERMINÍSTICAS ──────────────────────────────────────

  // R1 — Variação de lucro vs mês anterior (≥ 15% pra notificar)
  if (snapAnt?.lucro_liquido) {
    const delta = ((snapAtual.lucro_liquido - snapAnt.lucro_liquido) / Math.abs(snapAnt.lucro_liquido)) * 100;
    if (Math.abs(delta) >= 15) {
      const subiu = delta > 0;
      insights.push({
        tipo: subiu ? 'lucro_subiu' : 'lucro_caiu',
        severidade: subiu ? 'sucesso' : 'atencao',
        titulo: `Lucro ${subiu ? '+' : ''}${delta.toFixed(1)}% vs mês anterior`,
        descricao: subiu
          ? `Seu lucro líquido subiu de ${fmt(snapAnt.lucro_liquido)} para ${fmt(snapAtual.lucro_liquido)}. Identifique o que mudou para repetir.`
          : `Lucro caiu de ${fmt(snapAnt.lucro_liquido)} para ${fmt(snapAtual.lucro_liquido)}. Vale revisar custos e ticket médio.`,
        acao_label: 'Ver DRE',
        acao_url: '/negocios/dre',
        dados: { delta_pct: delta, atual: snapAtual.lucro_liquido, anterior: snapAnt.lucro_liquido },
      });
    }
  }

  // R2 — Plataforma top
  const topPlat = (snapAtual.por_plataforma || [])[0];
  if (topPlat && (snapAtual.por_plataforma || []).length > 1) {
    const totalPlat = (snapAtual.por_plataforma || []).reduce((s, p) => s + p.valor, 0);
    const pct = totalPlat > 0 ? (topPlat.valor / totalPlat) * 100 : 0;
    if (pct >= 60) {
      insights.push({
        tipo: 'plataforma_top',
        severidade: 'info',
        titulo: `${nomePlat(topPlat.plataforma)} representa ${pct.toFixed(0)}% da sua receita`,
        descricao: `Concentração alta numa só plataforma é risco — qualquer mudança lá afeta seu negócio inteiro. Vale ter diversificação.`,
        acao_label: 'Ver plataformas',
        acao_url: '/negocios/dre',
        dados: { plataforma: topPlat.plataforma, pct },
      });
    }
  }

  // R3 — Produto campeão
  const topProd = (snapAtual.por_produto || [])[0];
  if (topProd && snapAtual.receita_bruta > 0) {
    const pct = (topProd.valor / snapAtual.receita_bruta) * 100;
    if (pct >= 30) {
      insights.push({
        tipo: 'produto_top',
        severidade: 'sucesso',
        titulo: `${topProd.nome} puxou ${pct.toFixed(0)}% da sua receita`,
        descricao: `Seu produto campeão do mês. Vale entender o que está funcionando e dobrar a aposta.`,
        acao_label: 'Ver vendas',
        acao_url: '/negocios/vendas',
        dados: { produto: topProd.nome, pct },
      });
    }
  }

  // R4 — Imposto a reservar
  if (snapAtual.impostos > 0) {
    insights.push({
      tipo: 'imposto_reservar',
      severidade: 'atencao',
      titulo: `Reserve ${fmt(snapAtual.impostos)} para impostos`,
      descricao: `Esse é o valor que você deveria separar pro DAS/Simples deste mês. Não deixe pra última hora.`,
      acao_label: 'Configurar regime',
      acao_url: '/negocios',
      dados: { valor: snapAtual.impostos },
    });
  }

  // R5 — Custos altos vs receita (≥ 50%)
  if (snapAtual.receita_liquida > 0 && snapAtual.custos_total > 0) {
    const pctCusto = (snapAtual.custos_total / snapAtual.receita_liquida) * 100;
    if (pctCusto >= 50) {
      insights.push({
        tipo: 'custo_alto',
        severidade: 'critico',
        titulo: `Custos consomem ${pctCusto.toFixed(0)}% da receita líquida`,
        descricao: `Margem apertada. Vale revisar tráfego pago, ferramentas e equipe — qualquer aumento agora vira prejuízo.`,
        acao_label: 'Ver custos',
        acao_url: '/negocios',
        dados: { pct: pctCusto },
      });
    }
  }

  // R6 — Recorde de vendas
  if (snapAnt && snapAtual.total_vendas > snapAnt.total_vendas * 1.5 && snapAtual.total_vendas >= 10) {
    insights.push({
      tipo: 'vendas_recorde',
      severidade: 'sucesso',
      titulo: `Recorde: ${snapAtual.total_vendas} vendas no mês`,
      descricao: `${(((snapAtual.total_vendas / snapAnt.total_vendas) - 1) * 100).toFixed(0)}% acima do mês anterior. Mantenha o ritmo.`,
      dados: { vendas: snapAtual.total_vendas, anterior: snapAnt.total_vendas },
    });
  }

  // ─── INSIGHT NARRATIVO VIA CLAUDE (opcional, 1 por dia max) ──────
  if (usarClaude && insights.length > 0) {
    try {
      const jaTem = await jaTemNarrativoHoje(userId);
      if (!jaTem) {
        const narrativo = await gerarNarrativoComClaude(snapAtual, snapAnt);
        if (narrativo) insights.unshift(narrativo);
      }
    } catch (e) {
      console.warn('[insights] Claude falhou:', e.message);
    }
  }

  // ─── PERSISTÊNCIA (deduplicação por tipo no mesmo dia) ──────────
  const hojeStr = hoje.toISOString().slice(0, 10);
  const persistidos = [];
  for (const ins of insights) {
    const { data: existente } = await supabase
      .from('insights_negocio')
      .select('id')
      .eq('user_id', userId)
      .eq('tipo', ins.tipo)
      .gte('created_at', hojeStr)
      .maybeSingle();
    if (existente) continue;

    const { data, error } = await supabase
      .from('insights_negocio')
      .insert({ user_id: userId, grupo_id: grupoId, ...ins })
      .select().single();
    if (!error && data) persistidos.push(data);
  }

  return persistidos;
}

// ─── Helpers ─────────────────────────────────────────────────────

const NOMES_PLAT = {
  hotmart: 'Hotmart', kiwify: 'Kiwify', eduzz: 'Eduzz',
  stripe: 'Stripe', mercadopago: 'Mercado Pago',
};
function nomePlat(slug) { return NOMES_PLAT[slug] || slug; }

async function jaTemNarrativoHoje(userId) {
  const hojeStr = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('insights_negocio')
    .select('id')
    .eq('user_id', userId)
    .eq('tipo', 'sugestao')
    .gte('created_at', hojeStr)
    .maybeSingle();
  return !!data;
}

async function gerarNarrativoComClaude(snapAtual, snapAnt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contexto = {
    mes_atual: {
      receita_bruta: snapAtual.receita_bruta,
      lucro_liquido: snapAtual.lucro_liquido,
      margem_pct:    snapAtual.margem_pct,
      total_vendas:  snapAtual.total_vendas,
      ticket_medio:  snapAtual.ticket_medio,
      mrr:           snapAtual.mrr,
      por_plataforma: snapAtual.por_plataforma,
      por_produto:    (snapAtual.por_produto || []).slice(0, 5),
    },
    mes_anterior: snapAnt ? {
      receita_bruta: snapAnt.receita_bruta,
      lucro_liquido: snapAnt.lucro_liquido,
      total_vendas:  snapAnt.total_vendas,
    } : null,
  };

  const prompt = `Você é a Sora, consultora financeira sóbria para empreendedores digitais brasileiros.

Analise os dados do mês corrente vs anterior e identifique UMA observação ESPECÍFICA e ACIONÁVEL.

REGRAS:
- Tom direto e sóbrio, como um CFO experiente. Sem emoji, sem hype, sem "Opa!"
- Máximo 2 frases curtas na descrição
- Cite NÚMEROS reais (valores em R$ ou %)
- Foque em algo que o leitor PODE AGIR — não diga "está indo bem"
- Pode apontar oportunidades OU riscos

Retorne APENAS JSON válido neste formato:
{"titulo": "Frase curta e específica (até 60 chars)", "descricao": "Análise em 1-2 frases com números."}

Dados (valores em centavos):
${JSON.stringify(contexto, null, 2)}`;

  const msg = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const txt = msg.choices?.[0]?.message?.content || '';
  // Extrai JSON do output (Claude às vezes envolve em ```)
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return null; }

  if (!parsed.titulo || !parsed.descricao) return null;

  return {
    tipo: 'sugestao',
    severidade: 'info',
    titulo: parsed.titulo.slice(0, 200),
    descricao: parsed.descricao.slice(0, 500),
    acao_label: 'Ver DRE detalhado',
    acao_url: '/negocios/dre',
    dados: { fonte: 'claude' },
  };
}

module.exports = { gerarInsights };
