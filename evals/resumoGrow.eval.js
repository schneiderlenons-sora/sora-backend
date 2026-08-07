// =============================================================================
// EVAL do resumo semanal/mensal enriquecido com Grow (hábitos/tarefas/treino/
// estudos) + fallback local do insight (sem depender da OpenAI — testa só a
// parte determinística: gating de quem entra na mensagem, formatação e o
// fallback quando a IA falha).
//
// PEDIDO DO USUÁRIO: resumo mais personalizado, incluindo Grow "CASO O
// USUÁRIO UTILIZE" (silencioso pra quem nunca usou aquela aba) e comemorando
// quando o resultado foi excepcional (100% dos hábitos, treinou todo dia).
//
// Rodar:  npm run eval:resumo-grow
// =============================================================================
const { diasNoPeriodo } = require('../src/services/coletoresGrow');
const {
  linhasGrow, fmtGrow, fallbackInsight, montarCorpoSemanal, montarCorpoMensal,
} = require('../src/services/resumoFinanceiro');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. diasNoPeriodo ─────────────────────────────────────────────────────
console.log('── 1. dias no período ──');
{
  eq(diasNoPeriodo('2026-07-31', '2026-08-07'), 7, 'semana = 7 dias');
  eq(diasNoPeriodo('2026-07-01', '2026-08-01'), 31, 'julho tem 31 dias');
  eq(diasNoPeriodo('2026-02-01', '2026-03-01'), 28, 'fevereiro (não bissexto) tem 28');
  eq(diasNoPeriodo('2026-01-01', '2026-01-01'), 1, 'mesma data não quebra (mínimo 1)');
}
console.log('  ok');

// ── 2. linhasGrow: gating — só entra o que tem uso real ─────────────────
console.log('── 2. gating (CASO O USUÁRIO UTILIZE) ──');
{
  eq(linhasGrow(null), [], 'sem grow → nenhuma linha');
  eq(linhasGrow({}), [], 'grow vazio → nenhuma linha');
  eq(linhasGrow({ tarefas: { concluidas: 0 } }), [], 'tarefas com 0 concluídas fica silenciosa (não é "usa de verdade" essa semana)');
  eq(linhasGrow({ treino: { sessoes: 0 } }), [], 'treino com 0 sessões fica silencioso — sem naggy "você não treinou"');
  eq(linhasGrow({ estudos: { sessoes: 0 } }), [], 'estudos com 0 sessões fica silencioso');

  const l = linhasGrow({ tarefas: { concluidas: 3 } });
  eq(l.length, 1, 'tarefas com atividade real entra');
  ok(l[0].includes('3 concluídas'), 'linha de tarefas menciona a contagem certa');
}
console.log('  ok');

// ── 3. linhasGrow: hábitos SEMPRE aparece quando existe (mesmo em 0%) ────
// (mesma lógica de sempre mostrar Gastos, favorável ou não — informativo).
console.log('── 3. hábitos sempre aparece ──');
{
  const zerado = linhasGrow({ habitos: { ativos: 3, checkins: 0, possiveis: 21, taxa: 0, perfeito: false } });
  eq(zerado.length, 1, 'hábitos aparece mesmo com 0 check-ins');
  ok(zerado[0].includes('0%'), 'e mostra a taxa real (0%)');

  const perfeitoSemana = linhasGrow({ habitos: { ativos: 3, checkins: 21, possiveis: 21, taxa: 100, perfeito: true } }, 'semana');
  ok(/100%\s+da semana/.test(perfeitoSemana[0]), 'período "semana" usa a palavra certa');
  const perfeitoMes = linhasGrow({ habitos: { ativos: 3, checkins: 90, possiveis: 90, taxa: 100, perfeito: true } }, 'mes');
  ok(/100%\s+do mês/.test(perfeitoMes[0]), 'período "mes" usa a palavra certa');
}
console.log('  ok');

// ── 4. linhasGrow: treino com "todosDias" ganha destaque ────────────────
console.log('── 4. treino todo dia ──');
{
  const normal = linhasGrow({ treino: { sessoes: 2, minutos: 60, todosDias: false } });
  ok(!normal[0].includes('🔥'), 'sem treinar todo dia, sem o destaque');
  const todoDia = linhasGrow({ treino: { sessoes: 7, minutos: 300, todosDias: true } });
  ok(todoDia[0].includes('🔥'), 'treinou todo dia ganha o destaque visual');
}
console.log('  ok');

// ── 5. Combinação: só as abas presentes aparecem, na ordem certa ────────
console.log('── 5. combinação realista ──');
{
  const grow = {
    habitos: { ativos: 2, checkins: 10, possiveis: 14, taxa: 71, perfeito: false },
    tarefas: { concluidas: 5 },
    treino: { sessoes: 3, minutos: 150, todosDias: false },
    // sem estudos — usuário não usa essa aba
  };
  const linhas = linhasGrow(grow);
  eq(linhas.length, 3, 'só hábitos, tarefas e treino — sem estudos (não usa)');
  ok(linhas.some((l) => l.includes('Hábitos')), 'tem linha de hábitos');
  ok(linhas.some((l) => l.includes('Tarefas')), 'tem linha de tarefas');
  ok(linhas.some((l) => l.includes('Treino')), 'tem linha de treino');
  ok(!linhas.some((l) => l.includes('Estudos')), 'NÃO tem linha de estudos');
}
console.log('  ok');

// ── 6. fmtGrow (texto pro prompt da IA) ──────────────────────────────────
console.log('── 6. texto pro prompt ──');
{
  eq(fmtGrow(null), null, 'sem grow → null (prompt não menciona Grow)');
  eq(fmtGrow({}), null, 'grow vazio → null');
  const txt = fmtGrow({ habitos: { checkins: 5, possiveis: 7, taxa: 71, perfeito: false, melhorHabito: 'Beber água' } });
  ok(txt.includes('5/7') && txt.includes('71%') && txt.includes('Beber água'), 'texto do prompt tem os números certos');
  ok(!txt.includes('undefined') && !txt.includes('null'), 'nunca vaza undefined/null pro prompt');
}
console.log('  ok');

// ── 7. fallbackInsight: rede de segurança quando a IA falha ─────────────
console.log('── 7. fallback sem IA ──');
{
  // Sem grow: comportamento ORIGINAL preservado — regressão zero pra quem
  // não usa Grow nenhum (é a maioria hoje).
  const semGrow = fallbackInsight({
    periodo: 'semana',
    atual: { gastos: 400, count: 5, topCats: [['Mercado', 400]] },
    anterior: { gastos: 500 },
  });
  eq(semGrow.titulo, 'Sua semana', 'sem grow, título original');
  ok(semGrow.frase.includes('20%') || semGrow.frase.includes('menos'), 'sem grow, ainda calcula o delta de gastos');

  // Hábitos perfeitos comemora — mesmo sem IA.
  const perfeito = fallbackInsight({
    periodo: 'semana',
    atual: { gastos: 400, count: 5, topCats: [] },
    anterior: { gastos: 400 },
    grow: { habitos: { perfeito: true, melhorHabito: 'Beber água' } },
  });
  ok(/Beber água/.test(perfeito.frase), 'menciona o hábito de destaque');
  ok(/parabéns|Mandou|redonda/i.test(perfeito.titulo + perfeito.frase), 'tom de comemoração presente');

  // Treinou todo dia também comemora.
  const treinouTudo = fallbackInsight({
    periodo: 'semana',
    atual: { gastos: 400, count: 5, topCats: [] },
    anterior: { gastos: 400 },
    grow: { treino: { todosDias: true, diasTreinados: 7, sessoes: 7 } },
  });
  ok(/treino|disciplina/i.test(treinouTudo.titulo.toLowerCase()), 'título reconhece a disciplina de treino');

  // 1 dia treinado (não é "todos os dias") NÃO deve disparar a comemoração —
  // "todosDias" com só 1 sessão isolada seria falso positivo (semana de 1 dia?).
  const naoConta = fallbackInsight({
    periodo: 'semana',
    atual: { gastos: 400, count: 5, topCats: [['Mercado', 400]] },
    anterior: { gastos: 400 },
    grow: { treino: { todosDias: true, diasTreinados: 1, sessoes: 1 } },
  });
  eq(naoConta.titulo, 'Sua semana', 'treino de 1 dia só não aciona a comemoração de "todo dia"');
}
console.log('  ok');

// ── 8. Integração: a mensagem final inclui as linhas do Grow ────────────
console.log('── 8. montarCorpoSemanal/Mensal com grow ──');
{
  const atual = { gastos: 500, receitas: 1000, saldo: 500, topCats: [['Mercado', 500]] };
  const anterior = { gastos: 500 };
  const insight = { titulo: 'Semana estável', frase: 'Nada muito diferente por aqui.' };
  const grow = { tarefas: { concluidas: 2 }, treino: { sessoes: 1, minutos: 40, todosDias: false } };

  const semanal = montarCorpoSemanal({ atual, anterior, insight, grow });
  ok(semanal.includes('☑️ Tarefas: 2 concluídas'), 'semanal inclui a linha de tarefas');
  ok(semanal.includes('🏃 Treino'), 'semanal inclui a linha de treino');
  ok(semanal.includes('_Pra parar: *desativar resumos*_'), 'rodapé de opt-out continua no fim');

  const mensal = montarCorpoMensal({ mesNome: 'Julho', atual, anterior, metaMensal: 0, insight, grow });
  ok(mensal.includes('☑️ Tarefas: 2 concluídas'), 'mensal também inclui Grow');

  // Sem grow (undefined) não pode quebrar a montagem — é o caminho de quem
  // não usa Grow nenhum, continua sendo a maioria dos usuários hoje.
  const semGrowMsg = montarCorpoSemanal({ atual, anterior, insight });
  ok(!semGrowMsg.includes('undefined'), 'sem grow, mensagem não vaza undefined');
  ok(semGrowMsg.includes('_Pra parar: *desativar resumos*_'), 'e o rodapé ainda fecha certinho');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ resumo com Grow: todos os casos passaram');
