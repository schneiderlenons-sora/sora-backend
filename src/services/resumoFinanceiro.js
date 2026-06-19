// =====================================================================
// Resumos financeiros proativos (semanal + fechamento mensal).
// Calcula a partir de `transacoes` (tipo === 'Gasto' = despesa, senão
// receita), gera um INSIGHT em linguagem natural (gpt-4o-mini + fallback
// local) e monta o corpo da mensagem. O envio (com capa + botão) é feito
// pelo cron via zapi.enviarLink.
// =====================================================================
const supabase = require('../db/supabase');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const brl = (v) => `R$ ${Number(v || 0).toFixed(2)}`;
const limpaCat = (s) => (s || '').replace(/\p{Emoji}/gu, '').trim() || 'Outros';

/** Soma gastos/receitas/categorias de um grupo no intervalo [inicio, fim). Datas YYYY-MM-DD. */
async function resumoPeriodo(grupoId, inicio, fim) {
  const { data: rows } = await supabase
    .from('transacoes').select('tipo, categoria, valor, transferencia')
    .eq('grupo_id', grupoId)
    .gte('data', inicio).lt('data', fim);

  let gastos = 0, receitas = 0, count = 0;
  const cats = {};
  for (const r of rows || []) {
    count++;
    // Transferência (ex: pagamento de fatura = quitação de dívida) não é
    // consumo. Match por categoria é rede de segurança pra linhas sem a flag.
    if (r.transferencia || r.categoria === 'Fatura cartão') continue;
    if (r.tipo === 'Gasto') {
      gastos += r.valor || 0;
      const nome = limpaCat(r.categoria);
      cats[nome] = (cats[nome] || 0) + (r.valor || 0);
    } else {
      receitas += r.valor || 0;
    }
  }
  const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  return { gastos, receitas, saldo: receitas - gastos, count, topCats };
}

function deltaGastos(atual, anterior, label) {
  if (!anterior || anterior <= 0) return '';
  const pct = Math.round(((atual - anterior) / anterior) * 100);
  if (pct === 0) return ` (igual ${label})`;
  return ` (${pct < 0 ? '↓' : '↑'}${Math.abs(pct)}% ${label})`;
}

// ── INSIGHT (frase personalizada) ────────────────────────────────────
function fallbackInsight({ periodo, atual, anterior }) {
  const ant = periodo === 'mes' ? 'no mês anterior' : 'na semana passada';
  const top = atual.topCats[0];
  const delta = anterior.gastos > 0 ? Math.round(((atual.gastos - anterior.gastos) / anterior.gastos) * 100) : null;
  let frase;
  if (delta === null || atual.count === 0) {
    frase = top ? `Seu maior peso foi em ${top[0]}.` : 'Período tranquilo por aqui.';
  } else if (delta <= -5) {
    frase = `Você gastou ${Math.abs(delta)}% menos que ${ant} — mandou bem!${top ? ` Maior peso: ${top[0]}.` : ''}`;
  } else if (delta >= 5) {
    frase = `Os gastos subiram ${delta}% ${ant}${top ? `, puxados por ${top[0]}` : ''}.`;
  } else {
    frase = `Gastos parecidos com ${ant}${top ? `, com ${top[0]} no topo` : ''}.`;
  }
  return { titulo: periodo === 'mes' ? 'Fechamento do mês' : 'Sua semana', frase };
}

function parseJson(txt) {
  try { const m = (txt || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

/**
 * Insight em linguagem natural a partir dos números. gpt-4o-mini com
 * fallback local (nunca quebra o resumo). Retorna { titulo, frase }.
 */
async function gerarInsight({ periodo, atual, anterior }) {
  const fmtCats = (arr) => arr.slice(0, 8).map(([n, v]) => `${n} R$${Math.round(v)}`).join(', ') || 'nada';
  try {
    const sys = 'Você é a Sora, assistente financeira pessoal calorosa e perspicaz. ' +
      'Recebe os números de gastos de um usuário e escreve um INSIGHT curto sobre o período, em português do Brasil. ' +
      'Aponte o que mudou de verdade: categorias que subiram, caíram ou sumiram; se gastou mais ou menos. ' +
      'NÃO repita valores em reais (eles já aparecem na mensagem) — foque nos PADRÕES e no que isso revela do comportamento. ' +
      'Tom leve, humano e acolhedor, como um amigo esperto. Sem julgar e sem dar lição de moral. ' +
      'NÃO invente nada além dos dados. No máximo 2 frases curtas. ' +
      'Responda SOMENTE com JSON: {"titulo":"2 a 4 palavras criativas","frase":"o texto"}';
    const user = `Período: ${periodo === 'mes' ? 'mês' : 'semana'}.\n` +
      `Gastos: R$${Math.round(atual.gastos)} (período anterior: R$${Math.round(anterior.gastos)}).\n` +
      `Receitas: R$${Math.round(atual.receitas)}. Saldo: R$${Math.round(atual.saldo)}.\n` +
      `Categorias agora: ${fmtCats(atual.topCats)}.\n` +
      `Categorias antes: ${fmtCats(anterior.topCats)}.`;
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 180, temperature: 0.7,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    });
    const j = parseJson(r.choices?.[0]?.message?.content);
    if (j && j.titulo && j.frase) return { titulo: String(j.titulo).slice(0, 40), frase: String(j.frase).slice(0, 400) };
  } catch (e) {
    console.warn('[resumo] insight IA falhou, usando fallback:', e.message);
  }
  return fallbackInsight({ periodo, atual, anterior });
}

// ── CORPO DAS MENSAGENS ──────────────────────────────────────────────
const TITULO_SEMANAL = '📊 Sua semana em números';
const TITULO_MENSAL  = '🧾 Seu mês em números';
const CTA = 'Ver no painel';

function montarCorpoSemanal({ atual, anterior, insight }) {
  const partes = [
    `*${insight.titulo}*`,
    insight.frase,
    '',
    `🔴 Gastos: ${brl(atual.gastos)}${deltaGastos(atual.gastos, anterior.gastos, 'vs semana passada')}`,
    `🟢 Receitas: ${brl(atual.receitas)}`,
    `💰 *Saldo: ${brl(atual.saldo)}*`,
  ];
  if (atual.topCats.length) {
    const [nome, val] = atual.topCats[0];
    partes.push(`Maior categoria: *${nome}* (${brl(val)})`);
  }
  partes.push('', '_Pra parar: *desativar resumos*_');
  return partes.join('\n');
}

function montarCorpoMensal({ mesNome, atual, anterior, metaMensal, insight }) {
  const partes = [
    `*${insight.titulo}* · ${mesNome}`,
    insight.frase,
    '',
    `🔴 Gastos: ${brl(atual.gastos)}${deltaGastos(atual.gastos, anterior.gastos, 'vs mês anterior')}`,
    `🟢 Receitas: ${brl(atual.receitas)}`,
    `💰 *Saldo: ${brl(atual.saldo)}*`,
  ];
  if (atual.topCats.length) {
    partes.push('', '*Top categorias:*');
    atual.topCats.slice(0, 3).forEach(([nome, val]) => partes.push(`• ${nome}: ${brl(val)}`));
  }
  if (metaMensal > 0) {
    partes.push('', `🎯 Meta do mês: ${brl(metaMensal)} (${Math.round((atual.gastos / metaMensal) * 100)}% usado)`);
  }
  partes.push('', '_Pra parar: *desativar resumos*_');
  return partes.join('\n');
}

module.exports = {
  resumoPeriodo, gerarInsight,
  montarCorpoSemanal, montarCorpoMensal,
  TITULO_SEMANAL, TITULO_MENSAL, CTA,
};
