// =============================================================================
// EVAL da captura rápida de TAREFA/NOTA por linguagem natural (grow.js).
//
// ESCRITO A PARTIR DE UM BUG REAL reportado com prints do WhatsApp: "Tarefa
// melhorar sistema de gastos fixos e recorrências automáticas do painel" era
// sequestrado pelo interpretador de FINANÇAS (que roda ANTES do Grow no
// webhook) — o detector de "gastos com/de/em X" achava "do painel" como
// preposição+termo e respondia "Nenhum gasto encontrado para 'painel'". Sem
// "do painel" no fim, caía no fallback de "resumo do mês". E "Tarefa: X" (com
// dois-pontos) ficava com o prefixo GRUDADO no título salvo.
//
// Rodar:  npm run eval:captura-rapida
// =============================================================================
const G = require('../src/handlers/grow');
const { interpretarRapido } = require('../src/handlers/interpretador');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. OS 4 CASOS REAIS DO PRINT ────────────────────────────────────────────
console.log('── 1. os 4 casos reais do print ──');
{
  // (a) Funcionava — continua funcionando.
  eq(G.pareceTarefa('Tarefa: corrigir recorrências do Open Dinance'), true, 'a) reconhece tarefa');
  eq(G.extrairTituloTarefa('Tarefa: corrigir recorrências do Open Dinance'),
     'Corrigir recorrências do Open Dinance', 'a) título sem o "Tarefa:"');

  // (b) O interpretador de finanças SEQUESTRAVA esta mensagem antes do Grow —
  // sozinho (sem o marcador) ele REALMENTE acha "buscar painel" (prova de que
  // o bug é real e não foi "consertado" mudando o interpretador de finanças,
  // que continua intacto). Quem resolve é o webhook: com marcador explícito,
  // ele nunca chega a chamar interpretarRapido pra esta mensagem — só a
  // ORDEM muda, por isso o teste do contrato real é no marcador, não aqui.
  const msgB = 'Tarefa melhorar sistema de gastos fixos e recorrências automáticas do painel';
  const rb = interpretarRapido(msgB);
  eq(rb && rb.acao, 'buscar', 'b) confirma a causa raiz: interpretarRapido sozinho AINDA acha "buscar" nesta frase');
  eq(rb && rb.termo, 'painel', 'b) ...com termo "painel" (é por isso que o marcador precisa rodar ANTES dele)');
  eq(G.temMarcadorTarefaExplicito(msgB), true,
     'b) marcador explícito detecta o "Tarefa" no início — no webhook.js real, isto faz capturaRapida rodar ANTES de interpretarRapido');
  eq(G.pareceTarefa(msgB), true, 'b) e capturaRapida reconhece como tarefa');
  eq(G.extrairTituloTarefa(msgB), 'Melhorar sistema de gastos fixos e recorrências automáticas do painel', 'b) título correto, "gastos" não vira categoria');

  // (c) Mesma frase com "Tarefa:" na frente (prefixo DOBRADO, do jeito que o
  // usuário realmente digitou) — não pode sobrar "Tarefa" no título.
  const titC = G.extrairTituloTarefa('Tarefa: Tarefa melhorar sistema de gastos fixos e recorrências automáticas do painel');
  eq(titC, 'Melhorar sistema de gastos fixos e recorrências automáticas do painel', 'c) prefixo dobrado sai inteiro');
  ok(!/^tarefa/i.test(titC), 'c) título não pode começar com "Tarefa"');

  // (d) Sem "do painel" no fim — sozinho, o interpretador de finanças caía no
  // fallback de "resumo" (mesma causa raiz de b), e o marcador resolve igual.
  const msgD = 'Tarefa: Tarefa melhorar sistema de gastos fixos e recorrências automáticas';
  const rd = interpretarRapido(msgD);
  eq(rd && rd.acao, 'resumo', 'd) confirma a causa raiz: sozinho, cai no fallback de resumo do mês');
  eq(G.temMarcadorTarefaExplicito(msgD), true, 'd) marcador detecta e evita que isso aconteça no webhook real');
  eq(G.extrairTituloTarefa(msgD), 'Melhorar sistema de gastos fixos e recorrências automáticas', 'd) título limpo, sem "Tarefa" dobrado');
}
console.log('  ok');

// ── 2. Marcador explícito ("tarefa:"/"todo"/"to-do" no início) ─────────────
console.log('── 2. marcador explícito ──');
{
  eq(G.temMarcadorTarefaExplicito('Tarefa: X'), true, '"Tarefa: X"');
  eq(G.temMarcadorTarefaExplicito('tarefa X'), true, '"tarefa X" sem dois-pontos');
  eq(G.temMarcadorTarefaExplicito('TODO: revisar PR'), true, '"TODO:" maiúsculo');
  eq(G.temMarcadorTarefaExplicito('to-do - comprar leite'), true, '"to-do -"');
  eq(G.temMarcadorTarefaExplicito('  Tarefa:   X'), true, 'espaços extras não atrapalham');
  eq(G.temMarcadorTarefaExplicito('Sora, tarefa: ligar pro banco'), true, 'vocativo "Sora," na frente');
  // Não pode disparar por acidente no meio de outra frase.
  eq(G.temMarcadorTarefaExplicito('preciso fazer uma tarefa hoje'), false, '"tarefa" no MEIO da frase não é marcador');
  eq(G.temMarcadorTarefaExplicito('gastei 50 no mercado'), false, 'finanças não tem marcador');
  eq(G.temMarcadorTarefaExplicito(''), false, 'vazio não quebra');
}
console.log('  ok');

// ── 3. O bug do "Tarefa:" GRUDADO no título ─────────────────────────────────
console.log('── 3. dois-pontos não gruda no título ──');
{
  eq(G.extrairTituloTarefa('Tarefa: revisar contrato'), 'Revisar contrato', '"Tarefa: X"');
  eq(G.extrairTituloTarefa('Tarefa - revisar contrato'), 'Revisar contrato', '"Tarefa - X" (traço)');
  eq(G.extrairTituloTarefa('todo: comprar ração'), 'Comprar ração', '"todo:" minúsculo');
  eq(G.extrairTituloTarefa('to-do: enviar email'), 'Enviar email', '"to-do:"');
  eq(G.extrairTituloTarefa('nova tarefa: enviar proposta pro cliente'), 'Enviar proposta pro cliente',
     '"nova tarefa:" — mesmo bug do ":" quebrando o \\s+, achado ao revisar');
  eq(G.extrairTituloTarefa('cria tarefa: revisar contrato'), 'Revisar contrato', '"cria tarefa:"');
}
console.log('  ok');

// ── 4. "anota que" embrulhando um CUE de tarefa → vira TAREFA, não nota ────
console.log('── 4. "anota que tenho que/preciso" é tarefa disfarçada ──');
{
  eq(G.pareceNota('anota que tenho que fazer o design do site'), false, '"anota que tenho que" não é nota');
  eq(G.pareceTarefa('anota que tenho que fazer o design do site'), true, 'é tarefa');
  eq(G.extrairTituloTarefa('anota que tenho que fazer o design do site'), 'Fazer o design do site',
     'extrai só a ação — exemplo literal do usuário');

  eq(G.pareceNota('anota que preciso comprar leite'), false, '"anota que preciso" também não é nota');
  eq(G.pareceTarefa('anota que preciso comprar leite'), true, 'é tarefa');
  eq(G.extrairTituloTarefa('anota que preciso comprar leite'), 'Comprar leite', 'título limpo');

  eq(G.pareceNota('anota que não posso esquecer de pagar o boleto'), false, '"anota que não posso esquecer" é tarefa');
  eq(G.pareceTarefa('anota que não posso esquecer de pagar o boleto'), true, 'é tarefa');

  // Nota DE VERDADE continua nota — não pode virar tarefa por engano.
  eq(G.pareceNota('anota que gostei muito do restaurante novo'), true, 'nota genuína continua nota');
  eq(G.pareceTarefa('anota que gostei muito do restaurante novo'), false, 'e não vira tarefa');
  eq(G.pareceNota('anota que o wifi de casa é 12345'), true, 'anotar uma informação continua nota');
}
console.log('  ok');

// ── 5. "até <dia>" é PRAZO de tarefa, não hora de compromisso ──────────────
console.log('── 5. prazo ("até sexta") ──');
{
  eq(G.pareceTarefa('preciso terminar o trabalho até sexta'), true,
     'data introduzida por "até" não bloqueia mais a tarefa — exemplo do usuário');
  const titulo = G.extrairTituloTarefa('preciso terminar o trabalho até sexta');
  eq(titulo, 'Terminar o trabalho', 'prazo sai do título');
  const prazo = G.prazoTarefa('preciso terminar o trabalho até sexta');
  ok(!!prazo && /^\d{4}-\d{2}-\d{2}$/.test(prazo.iso), 'prazo tem uma data ISO válida');

  eq(G.pareceTarefa('tenho que entregar o relatório até amanhã'), true, '"até amanhã" também é prazo');
  eq(G.extrairTituloTarefa('tenho que entregar o relatório até amanhã'), 'Entregar o relatório', 'prazo sai');

  // "até" sem data reconhecida (não é prazo de verdade) fica no título como veio.
  eq(G.prazoTarefa('tenho que ir até o mercado'), null, '"até o mercado" não é data');
  eq(G.extrairTituloTarefa('tenho que ir até o mercado'), 'Ir até o mercado', 'e não é cortado do título');

  // "até <dia> às <hora>" TEM hora → continua indo pra Agenda (compromisso),
  // não pode virar tarefa — regra de ouro preservada.
  eq(G.prazoTarefa('reunião até sexta às 15h'), null, 'com hora junto, não conta como prazo de tarefa');
}
console.log('  ok');

// ── 6. NÃO PODE QUEBRAR: comandos de finanças continuam finanças ───────────
console.log('── 6. finanças intactas ──');
{
  const financas = [
    ['gastei 50 no mercado', 'salvar'],
    ['quanto gastei esse mês', 'resumo'],
    ['gastos com alimentação', 'buscar'],
    ['gastos por cartão e conta', 'gastos_carteiras'],
    ['quanto custa o plano premium', null], // "planos?" cai no RE_NAO_TAREFA / não é comando conhecido aqui
  ];
  for (const [msg, esperado] of financas) {
    ok(!G.temMarcadorTarefaExplicito(msg), `"${msg}" não tem marcador de tarefa`);
    if (esperado) {
      const r = interpretarRapido(msg);
      eq(r && r.acao, esperado, `interpretarRapido("${msg}") continua ${esperado}`);
    }
  }
  // Nenhuma dessas pode virar tarefa nem nota.
  for (const [msg] of financas) {
    ok(!G.pareceTarefa(msg), `"${msg}" não é tarefa`);
    ok(!G.pareceNota(msg), `"${msg}" não é nota`);
  }
}
console.log('  ok');

// ── 7. NÃO PODE QUEBRAR: os formatos de tarefa que já funcionavam ──────────
console.log('── 7. formatos antigos de tarefa intactos ──');
{
  const casos = [
    ['lembra de comprar as passagens', 'Comprar as passagens'],
    ['tenho que ligar pro dentista', 'Ligar pro dentista'],
    ['não esqueça de pagar a conta', 'Pagar a conta'],
    ['não posso esquecer de pegar o filho na escola', 'Pegar o filho na escola'],
    ['cria tarefa revisar contrato', 'Revisar contrato'],
    ['adiciona tarefa comprar ração', 'Comprar ração'],
    ['tarefa ligar pro contador', 'Ligar pro contador'],
    ['todo enviar relatório', 'Enviar relatório'],
  ];
  for (const [msg, tituloEsperado] of casos) {
    eq(G.pareceTarefa(msg), true, `"${msg}" continua sendo reconhecida`);
    eq(G.extrairTituloTarefa(msg), tituloEsperado, `"${msg}" → título`);
  }
}
console.log('  ok');

// ── 8. NÃO PODE QUEBRAR: Agenda (compromisso) continua vencendo quando tem hora ──
console.log('── 8. agenda com hora continua agenda ──');
{
  eq(G.pareceTarefa('tenho reunião terça às 15h'), false, 'hora marcada é compromisso, não tarefa');
  eq(G.pareceCompromisso('marca dentista terça 15h'), true, 'compromisso direto continua reconhecido');
}
console.log('  ok');

// ── 9. Prioridade urgente/alta continua funcionando junto com o resto ──────
console.log('── 9. prioridade + marcador ──');
{
  eq(G.pareceTarefa('Tarefa urgente: pagar o cartão hoje'.replace(/\shoje$/, '')), true, 'urgente com marcador');
  eq(G.temMarcadorTarefaExplicito('Tarefa urgente: pagar o cartão'), true, 'marcador com "urgente" no meio');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ captura rápida (tarefa/nota): todos os casos passaram');
