// =====================================================================
// Resumos financeiros proativos (semanal + fechamento mensal).
// Calcula a partir de `transacoes` (tipo === 'Gasto' = despesa, senão
// receita), gera um INSIGHT em linguagem natural (gpt-4o-mini + fallback
// local) e monta o corpo da mensagem. O envio (com capa + botão) é feito
// pelo cron via zapi.enviarLink.
// =====================================================================
const supabase = require('../db/supabase');
const { ehPagamentoFatura } = require('./categorizar');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ⚠️ Achado testando o insight com a IA de verdade: `.toFixed(2)` usa PONTO
// como separador decimal em JS, sempre — "R$ 600.00" em vez de "R$ 600,00".
// Bug pré-existente (não é meu), mas real: quem recebe o resumo toda semana
// via essa função. jobs/index.js já tem a versão CERTA (toLocaleString
// pt-BR) — espelhando aqui, mesma convenção do resto do projeto (CLAUDE.md).
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
    if (r.transferencia || ehPagamentoFatura(r.categoria)) continue;
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
//
// `grow` (opcional) = saída de services/coletoresGrow.coletarGrow — só traz
// as abas que o usuário REALMENTE usa (hábitos/tarefas/treino/estudos). O
// insight passa a poder falar de rotina, não só de dinheiro, e a comemorar
// quando algo foi excepcional (100% dos hábitos, treinou todo dia) — pedido
// explícito do usuário, inspirado no resumo do Pierre ("Semana mais digital",
// frase construída em cima do que mudou, não um texto fixo).
function fallbackInsight({ periodo, atual, anterior, grow }) {
  const ant = periodo === 'mes' ? 'no mês anterior' : 'na semana passada';
  const top = atual.topCats[0];
  const delta = anterior.gastos > 0 ? Math.round(((atual.gastos - anterior.gastos) / anterior.gastos) * 100) : null;

  // Sem IA, o Grow só entra pra um "parabéns" objetivo — não dá pra tecer uma
  // frase natural sem o modelo, mas dá pra reconhecer um resultado perfeito.
  if (grow?.habitos?.perfeito) {
    return { titulo: 'Semana redonda 🏆', frase: `Você marcou todos os seus hábitos essa semana — principalmente ${grow.habitos.melhorHabito}. Mandou muito bem!` };
  }
  if (grow?.treino?.todosDias && grow.treino.diasTreinados > 1) {
    return { titulo: 'Semana de disciplina 💪', frase: `Você treinou todos os dias essa semana (${grow.treino.sessoes} sessões) — isso é consistência de verdade!` };
  }

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

// Texto compacto do Grow pro prompt — só entram as abas que o coletor achou
// (usuário usa de verdade). Formato solto de propósito: é pra IA LER, não pra
// exibir; ela decide o que vale mencionar.
function fmtGrow(grow) {
  if (!grow || !Object.keys(grow).length) return null;
  const partes = [];
  if (grow.habitos) {
    const h = grow.habitos;
    partes.push(`Hábitos: ${h.checkins}/${h.possiveis} marcados (${h.taxa}%)${h.perfeito ? ' — TODOS os dias, 100%' : ''}${h.melhorHabito ? `, destaque "${h.melhorHabito}"` : ''}.`);
  }
  if (grow.tarefas) {
    const t = grow.tarefas;
    partes.push(`Tarefas: ${t.concluidas} concluída(s), ${t.criadas} criada(s), ${t.pendentes} pendente(s) no total${t.destaque ? `; concluiu "${t.destaque}"` : ''}.`);
  }
  if (grow.treino) {
    const tr = grow.treino;
    partes.push(`Treino: ${tr.sessoes} sessão(ões) em ${tr.diasTreinados}/${tr.diasNoPeriodo} dias, ${tr.minutos} min${tr.todosDias ? ' — treinou TODO dia' : ''}${tr.tipoTop ? `, principalmente ${tr.tipoTop}` : ''}.`);
  }
  if (grow.estudos) {
    const e = grow.estudos;
    partes.push(`Estudos: ${e.sessoes} sessão(ões), ${e.minutos} min${e.disciplinaForte ? `, foco em ${e.disciplinaForte}` : ''}.`);
  }
  return partes.join(' ');
}

/**
 * Insight em linguagem natural a partir dos números — financeiro E, quando
 * disponível, Grow (hábitos/tarefas/treino/estudos). gpt-4o-mini com fallback
 * local (nunca quebra o resumo). Retorna { titulo, frase }.
 */
async function gerarInsight({ periodo, atual, anterior, grow }) {
  const fmtCats = (arr) => arr.slice(0, 8).map(([n, v]) => `${n} R$${Math.round(v)}`).join(', ') || 'nada';
  const growTxt = fmtGrow(grow);
  try {
    const sys = 'Você é a Sora, assistente financeira e de rotina pessoal, calorosa e perspicaz. ' +
      'Recebe os números do período de um usuário — finanças e, quando houver, hábitos/tarefas/treino/estudos — ' +
      'e escreve UM insight curto e pessoal sobre o período inteiro, em português do Brasil.\n\n' +
      'TÍTULO: uma manchete curta (até ~6 palavras) que resume o que mais chamou atenção no período — pode ser ' +
      'sobre dinheiro OU sobre rotina, o que for mais marcante. Ex.: "Semana mais digital", "Mês mais calmo", ' +
      '"Semana de disciplina". Se o resultado foi excepcional (100% dos hábitos, treinou todo dia, gasto bem menor), ' +
      'pode comemorar ou parabenizar — no título ou na frase, não nos dois ao mesmo tempo.\n' +
      'FRASE: 1 a 2 frases curtas combinando o que mudou de verdade — categorias que sumiram/surgiram, se gastou ' +
      'mais/menos, e (só se houver dado) hábitos/treino/estudos/tarefas. NÃO repita valores em reais (já aparecem ' +
      'na mensagem) — foque em PADRÕES e no que isso revela.\n' +
      'Tom leve, humano, como um amigo esperto. Sem julgar, sem lição de moral, sem exagero. ' +
      'NÃO invente nada além dos dados fornecidos — se uma área não veio nos dados, não fale dela. ' +
      'Responda SOMENTE com JSON: {"titulo":"...","frase":"..."}';
    // Few-shot: ancora o tom e mostra como misturar finanças + Grow sem forçar.
    const exemplos = [
      [
        'Período: semana.\nGastos: R$450 (período anterior: R$820).\nReceitas: R$1200. Saldo: R$750.\n' +
        'Categorias agora: Mercado R$300, Farmácia R$150.\nCategorias antes: iFood R$400, Uber R$220, Mercado R$200.',
        '{"titulo":"Semana mais em casa","frase":"iFood e Uber sumiram do seu radar essa semana — o gasto caiu quase pela metade, quase tudo foi mercado e farmácia."}',
      ],
      [
        'Período: semana.\nGastos: R$680 (período anterior: R$700).\nReceitas: R$1000. Saldo: R$320.\n' +
        'Categorias agora: Mercado R$400, Assinaturas R$180.\nCategorias antes: Mercado R$420, Assinaturas R$180.\n' +
        'Hábitos: 21/21 marcados (100%) — TODOS os dias, 100%, destaque "Beber água".\n' +
        'Treino: 5 sessão(ões) em 5/7 dias, 240 min — principalmente Academia.',
        '{"titulo":"Semana redonda 🏆","frase":"Fora o financeiro estável, o destaque foi você: hábitos 100% marcados a semana inteira e 5 treinos na academia. Mandou muito bem!"}',
      ],
      [
        'Período: mês.\nGastos: R$3200 (período anterior: R$2900).\nReceitas: R$4500. Saldo: R$1300.\n' +
        'Categorias agora: Aluguel R$1500, Mercado R$800, Assinaturas R$300, IOF R$120.\n' +
        'Categorias antes: Aluguel R$1500, Mercado R$750, Assinaturas R$300.',
        '{"titulo":"Mês com um gasto fora da curva","frase":"O mês seguiu parecido com o anterior, só que com um IOF de R$120 que não costuma aparecer — vale conferir se foi algo pontual."}',
      ],
    ];
    const user = `Período: ${periodo === 'mes' ? 'mês' : 'semana'}.\n` +
      `Gastos: R$${Math.round(atual.gastos)} (período anterior: R$${Math.round(anterior.gastos)}).\n` +
      `Receitas: R$${Math.round(atual.receitas)}. Saldo: R$${Math.round(atual.saldo)}.\n` +
      `Categorias agora: ${fmtCats(atual.topCats)}.\n` +
      `Categorias antes: ${fmtCats(anterior.topCats)}.` +
      (growTxt ? `\n${growTxt}` : '');
    const messages = [{ role: 'system', content: sys }];
    for (const [u, a] of exemplos) messages.push({ role: 'user', content: u }, { role: 'assistant', content: a });
    messages.push({ role: 'user', content: user });
    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 220, temperature: 0.7, messages,
    });
    const j = parseJson(r.choices?.[0]?.message?.content);
    if (j && j.titulo && j.frase) return { titulo: String(j.titulo).slice(0, 60), frase: String(j.frase).slice(0, 400) };
  } catch (e) {
    console.warn('[resumo] insight IA falhou, usando fallback:', e.message);
  }
  return fallbackInsight({ periodo, atual, anterior, grow });
}

// ── CORPO DAS MENSAGENS ──────────────────────────────────────────────
const TITULO_SEMANAL = '📊 Sua semana em números';
const TITULO_MENSAL  = '🧾 Seu mês em números';
const CTA = 'Ver no painel';

/**
 * Linhas compactas do Grow pro corpo da mensagem — só as abas presentes em
 * `grow` (coletoresGrow.coletarGrow), na mesma pegada das linhas 🔴/🟢/💰
 * que já existiam. `[]` quando o usuário não usa nada do Grow.
 *
 * Hábitos sempre aparece quando existe (a % é neutra, informativa — mesma
 * lógica de sempre mostrar Gastos mesmo quando não é lisonjeiro). Tarefas/
 * Treino/Estudos só aparecem com atividade de verdade (>0): uma linha fria
 * de "0 sessões" seria naggy, e o pedido do usuário foi comemorar o que vai
 * bem, não cobrar o que não aconteceu — se for relevante, o insight (frase
 * gerada) já pode tocar nisso com mais tato.
 */
function linhasGrow(grow, periodo = 'semana') {
  if (!grow || !Object.keys(grow).length) return [];
  const linhas = [];
  if (grow.habitos) {
    const h = grow.habitos;
    linhas.push(h.perfeito
      ? `✅ *Hábitos: 100% ${periodo === 'mes' ? 'do mês' : 'da semana'}!* 🏆`
      : `✅ Hábitos: ${h.checkins}/${h.possiveis} marcados (${h.taxa}%)`);
  }
  if (grow.tarefas?.concluidas > 0) {
    linhas.push(`☑️ Tarefas: ${grow.tarefas.concluidas} concluída${grow.tarefas.concluidas === 1 ? '' : 's'}`);
  }
  if (grow.treino?.sessoes > 0) {
    const t = grow.treino;
    // ⚠️ "sessão" + "ões" concatenado dá "sessãoões" — "-ão" vira "-ões" por
    // TROCA, não por acréscimo. Achado testando com a IA de verdade (saiu
    // "5 sessãoões" na mensagem real). Palavra inteira no ternário, não sufixo.
    const palavra = t.sessoes === 1 ? 'sessão' : 'sessões';
    linhas.push(`🏃 Treino: ${t.sessoes} ${palavra}${t.minutos ? ` · ${t.minutos} min` : ''}${t.todosDias ? ' 🔥' : ''}`);
  }
  if (grow.estudos?.sessoes > 0) {
    const palavra = grow.estudos.sessoes === 1 ? 'sessão' : 'sessões';
    linhas.push(`📚 Estudos: ${grow.estudos.sessoes} ${palavra} · ${grow.estudos.minutos} min`);
  }
  return linhas;
}

function montarCorpoSemanal({ atual, anterior, insight, grow }) {
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
  const gLinhas = linhasGrow(grow);
  if (gLinhas.length) partes.push('', ...gLinhas);
  partes.push('', '_Pra parar: *desativar resumos*_');
  return partes.join('\n');
}

function montarCorpoMensal({ mesNome, atual, anterior, metaMensal, insight, grow }) {
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
    partes.push('', `🎯 Limite Geral: ${brl(metaMensal)} (${Math.round((atual.gastos / metaMensal) * 100)}% usado)`);
  }
  const gLinhas = linhasGrow(grow, 'mes');
  if (gLinhas.length) partes.push('', ...gLinhas);
  partes.push('', '_Pra parar: *desativar resumos*_');
  return partes.join('\n');
}

module.exports = {
  resumoPeriodo, gerarInsight, fmtGrow, linhasGrow, deltaGastos,
  montarCorpoSemanal, montarCorpoMensal,
  TITULO_SEMANAL, TITULO_MENSAL, CTA,
  fallbackInsight, // exposto pra teste — é a rede de segurança quando a IA falha
};
