// =============================================================================
// EVAL — lembrete diário de tarefas em aberto.
//
// Pedido do cliente (01/10/2026): "duas condições seriam interessantes: uma
// com lembrete diário e outra quando o prazo estiver chegando".
//
// As 5 tarefas REAIS da conta dele (todas sem data_vencimento, porque tarefa
// criada pelo WhatsApp nasce sem data) estão em §2 — é o caso que uma
// implementação "só com prazo" deixaria de fora justamente para quem pediu.
//
// Rodar:  node evals/lembreteTarefas.eval.js
// =============================================================================
const {
  tarefasDoLembrete, textoDoLembrete, resumoCurto, situacaoDe, diasAte,
} = require('../src/services/lembreteTarefas');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const HOJE = '2026-10-01';
const URL = 'https://www.forsora.com/grow/tarefas';

console.log('── 1. a ORDEM: prazo manda ──');
{
  // ⚠️ A ENTRADA ESTÁ NA ORDEM INVERSA DA ESPERADA DE PROPÓSITO — inclusive
  // entre as duas atrasadas, e com `created_at` IGUAL. Assim nenhum critério de
  // desempate (nem a estabilidade do sort) produz o resultado por acaso: só a
  // ordenação por data mais próxima chega nele.
  const tarefas = [
    { id: 'e', titulo: 'Sem prazo',       concluida: false, data_vencimento: null,         created_at: '2026-01-01' },
    { id: 'c', titulo: 'Vence em 3 dias', concluida: false, data_vencimento: '2026-10-04', created_at: '2026-01-01' },
    { id: 'a2', titulo: 'Atrasada 1 dia', concluida: false, data_vencimento: '2026-09-30', created_at: '2026-01-01' },
    { id: 'b', titulo: 'Vence hoje',      concluida: false, data_vencimento: '2026-10-01', created_at: '2026-01-01' },
    { id: 'a', titulo: 'Atrasada 5 dias', concluida: false, data_vencimento: '2026-09-26', created_at: '2026-01-01' },
  ];
  const r = tarefasDoLembrete({ tarefas, hojeStr: HOJE });
  eq(r.itens.map((t) => t.id).join(','), 'a,a2,b,c,e',
    '§1 atrasada mais antiga → atrasada → hoje → em breve → sem prazo');
  eq(r.atrasadas, 2, '§1 conta as atrasadas');
  eq(r.total, 5, '§1 total em aberto');
  eq(r.ocultas, 0, '§1 cabem todas');
}
console.log('  ok');

console.log('── 2. ⚠️ AS 5 TAREFAS REAIS DELE (nenhuma com prazo) ──');
{
  // Se o lembrete só olhasse prazo, ele receberia uma mensagem vazia — ou
  // nenhuma — exatamente no recurso que pediu.
  const dele = [
    { id: '1', titulo: 'enviar mensagem para o gastro', concluida: false, data_vencimento: null, created_at: '2026-09-20' },
    { id: '2', titulo: 'Ver as pendências para a Coreia em 30 minutos', concluida: false, data_vencimento: null, created_at: '2026-09-18' },
    { id: '3', titulo: 'Preparar o caso da paciente com zumbido', concluida: true, data_vencimento: null, created_at: '2026-09-10' },
    { id: '4', titulo: 'ver a reserva do hotel boutique vila dom pato', concluida: true, data_vencimento: null, created_at: '2026-09-11' },
    { id: '5', titulo: 'Eu preciso fazer o curso de parada cardiorrespiratória', concluida: false, data_vencimento: null, created_at: '2026-09-12' },
  ];
  const r = tarefasDoLembrete({ tarefas: dele, hojeStr: HOJE });
  eq(r.total, 3, '⚠️ §2 as 3 em aberto entram (as 2 concluídas, não)');
  eq(r.atrasadas, 0, '§2 sem prazo não é atraso');
  eq(r.itens[0].id, '5', '§2 a mais antiga em aberto primeiro');
  eq(r.itens[0].situacao, null, '§2 sem prazo não inventa situação');

  const txt = textoDoLembrete(r, URL);
  // O `*` é o negrito do WhatsApp — a asserção olha o conteúdo, não a marcação.
  eq(/\*3\*\s+tarefas em aberto/.test(txt), true, '§2 o texto diz quantas são');
  eq(txt.includes('enviar mensagem para o gastro'), true, '§2 e lista os títulos');
  eq(/atrasada/.test(txt), false, '§2 não fala de atraso quando não há');
}
console.log('  ok');

console.log('── 3. ⚠️ CONCLUÍDA NUNCA ENTRA ──');
{
  const r = tarefasDoLembrete({
    tarefas: [
      { id: '1', titulo: 'Feita', concluida: true, data_vencimento: '2026-09-01' },
      { id: '2', titulo: 'Aberta', concluida: false, data_vencimento: null },
    ],
    hojeStr: HOJE,
  });
  eq(r.total, 1, '§3 só a aberta');
  eq(r.itens[0].titulo, 'Aberta', '§3 …e é a certa');
  // `concluida` ausente (linha antiga) conta como aberta — some seria pior.
  eq(tarefasDoLembrete({ tarefas: [{ id: 'x', titulo: 'Sem flag' }], hojeStr: HOJE }).total, 1,
    '§3 sem a flag, trata como aberta');
}
console.log('  ok');

console.log('── 4. lista longa: corta e AVISA ──');
{
  const muitas = Array.from({ length: 23 }, (_, i) => ({
    id: String(i), titulo: `Tarefa ${i}`, concluida: false, data_vencimento: null, created_at: `2026-09-${String(i + 1).padStart(2, '0')}`,
  }));
  const r = tarefasDoLembrete({ tarefas: muitas, hojeStr: HOJE });
  eq(r.itens.length, 5, '§4 mostra 5 (o MAX_LISTA dos templates)');
  eq(r.ocultas, 18, '⚠️ §4 e diz quantas ficaram de fora');
  eq(r.total, 23, '§4 o total continua sendo o real');
  const txt = textoDoLembrete(r, URL);
  eq(txt.includes('e mais 18'), true, '§4 o texto não esconde o resto');
}
console.log('  ok');

console.log('── 5. nada em aberto = nada a enviar ──');
{
  // Quem decide não mandar é o cron, mas o total é o sinal — e ele precisa ser 0.
  eq(tarefasDoLembrete({ tarefas: [], hojeStr: HOJE }).total, 0, '§5 lista vazia');
  eq(tarefasDoLembrete({ tarefas: null, hojeStr: HOJE }).total, 0, '§5 null não quebra');
  eq(tarefasDoLembrete({
    tarefas: [{ id: '1', titulo: 'x', concluida: true }], hojeStr: HOJE,
  }).total, 0, '§5 tudo concluído → nada a lembrar');
}
console.log('  ok');

console.log('── 6. como a situação é dita ──');
{
  eq(situacaoDe(0), 'vence hoje', '§6 hoje');
  eq(situacaoDe(1), 'vence amanhã', '§6 amanhã');
  eq(situacaoDe(5), 'vence em 5 dias', '§6 futuro');
  eq(situacaoDe(-1), 'atrasada 1 dia', '§6 um dia no singular');
  eq(situacaoDe(-9), 'atrasada 9 dias', '§6 plural');
  eq(situacaoDe(null), null, '§6 sem prazo não tem situação');
}
console.log('  ok');

console.log('── 7. ⚠️ A DATA NÃO PODE ESCORREGAR DE FUSO ──');
{
  // `data_vencimento` pode chegar como data pura ou como timestamp — e um dia
  // a mais ou a menos transforma "vence hoje" em "atrasada".
  eq(diasAte('2026-10-01', HOJE), 0, '§7 data pura, mesmo dia');
  eq(diasAte('2026-10-01T00:00:00+00:00', HOJE), 0, '⚠️ §7 timestamp à meia-noite UTC ainda é hoje');
  eq(diasAte('2026-09-30', HOJE), -1, '§7 ontem');
  eq(diasAte('2026-10-31', HOJE), 30, '§7 atravessa o mês');
  eq(diasAte('2027-01-01', '2026-12-31'), 1, '§7 atravessa o ano');
  eq(diasAte(null, HOJE), null, '§7 sem data');
  eq(diasAte('lixo', HOJE), null, '§7 data inválida não vira 0');
}
console.log('  ok');

console.log('── 8. o resumo curto do template ──');
{
  const r = tarefasDoLembrete({
    tarefas: [
      { id: '1', titulo: 'Ligar pro gastro', concluida: false, data_vencimento: '2026-09-28' },
      { id: '2', titulo: 'Comprar passagem', concluida: false, data_vencimento: null },
    ],
    hojeStr: HOJE,
  });
  const curto = resumoCurto(r);
  eq(curto.includes('\n'), false, '⚠️ §8 UMA LINHA — a Meta recusa quebra em parâmetro');
  eq(curto.includes('1 atrasada'), true, '§8 destaca o atraso');
  eq(curto.includes('Ligar pro gastro'), true, '§8 e nomeia as tarefas');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ lembreteTarefas: todos os casos passaram');
