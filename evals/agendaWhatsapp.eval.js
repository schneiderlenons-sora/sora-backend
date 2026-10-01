// =============================================================================
// EVAL — "minha agenda" no WhatsApp: período e tamanho da mensagem.
//
// Pedido de cliente (30/09/2026): a agenda pelo WhatsApp devolvia só 7 dias;
// ele queria 30, "para facilitar a programação pessoal para o mês inteiro".
//
// ⚠️ Trocar o 7 por 30 sozinho quebraria a resposta: o corpo de uma mensagem
// interativa da Cloud API é cortado em 1024 caracteres, em silêncio, no meio
// da linha. §3 trava isso.
//
// ⚠️ E o reconhecedor NÃO pode engolir a CRIAÇÃO de compromisso: o mesmo verbo
// serve pras duas coisas ("agenda dentista terça 15h"). §2 trava isso.
//
// Rodar:  node evals/agendaWhatsapp.eval.js
// =============================================================================
const {
  periodoDaFrase, janela, montarAgenda, hojeSP, somarDias,
} = require('../src/services/agendaWhatsapp');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

console.log('── 1. o período pedido ──');
{
  // ⚠️ O PEDIDO: sem sufixo, agora são 30 dias (era 7).
  eq(periodoDaFrase('agenda')?.dias, 30, '§1 "agenda" → 30 dias');
  eq(periodoDaFrase('minha agenda')?.dias, 30, '§1 "minha agenda" → 30 dias');
  eq(periodoDaFrase('meus compromissos')?.dias, 30, '§1 "meus compromissos" → 30 dias');
  eq(periodoDaFrase('compromissos')?.dias, 30, '§1 "compromissos" → 30 dias');

  // Quem quer menos continua conseguindo pedir.
  eq(periodoDaFrase('agenda hoje')?.dias, 0, '§1 "agenda hoje" → só hoje');
  eq(periodoDaFrase('agenda semana')?.dias, 7, '§1 "agenda semana" → 7');
  eq(periodoDaFrase('agenda da semana')?.dias, 7, '§1 "agenda da semana" → 7');
  eq(periodoDaFrase('agenda esta semana')?.dias, 7, '§1 "agenda esta semana" → 7');
  eq(periodoDaFrase('minha agenda do mes')?.dias, 30, '§1 "agenda do mês" → 30');
  eq(periodoDaFrase('agenda do mês')?.dias, 30, '§1 com acento também');
  eq(periodoDaFrase('agenda 15 dias')?.dias, 15, '§1 número explícito');
  eq(periodoDaFrase('agenda dos proximos 60 dias')?.dias, 60, '§1 "próximos N dias"');
  eq(periodoDaFrase('agenda amanha')?.dias, 1, '§1 "amanhã"');
  // Teto: lista maior que isso ninguém lê no WhatsApp.
  eq(periodoDaFrase('agenda 999 dias')?.dias, 90, '§1 teto de 90 dias');
  // Tolerâncias de digitação.
  eq(periodoDaFrase('  Agenda  ')?.dias, 30, '§1 espaços e maiúscula');
  eq(periodoDaFrase('minha agenda?')?.dias, 30, '§1 com interrogação');
}
console.log('  ok');

console.log('── 2. ⚠️ NÃO PODE SEQUESTRAR A CRIAÇÃO ──');
{
  // O MESMO verbo cria compromisso. Se estas frases virassem consulta, a
  // pessoa pediria pra marcar o dentista e receberia a lista de volta.
  eq(periodoDaFrase('agenda dentista terça 15h'), null, '⚠️ §2 "agenda dentista terça 15h" NÃO é consulta');
  eq(periodoDaFrase('agendar reunião amanhã 9h'), null, '⚠️ §2 "agendar reunião amanhã 9h" NÃO é consulta');
  eq(periodoDaFrase('marca dentista terça'), null, '§2 outro verbo de criação');
  eq(periodoDaFrase('agenda consulta médica'), null, '§2 substantivo solto não é período');
  eq(periodoDaFrase('quanto gastei esse mês'), null, '§2 frase de finanças');
  eq(periodoDaFrase(''), null, '§2 vazio');
  eq(periodoDaFrase(null), null, '§2 null não quebra');
  // "amanhã" É um período válido sozinho, mas não com um assunto junto.
  eq(periodoDaFrase('agenda reunião amanha'), null, '⚠️ §2 assunto + período ainda é criação');
}
console.log('  ok');

console.log('── 3. ⚠️ A MENSAGEM TEM DE CABER EM 1024 ──');
{
  const hojeStr = '2026-09-30';
  // 30 dias com 3 compromissos por dia: é o cenário que o pedido cria.
  const muitos = [];
  for (let d = 0; d < 30; d++) {
    const dia = somarDias(hojeStr, d);
    for (let i = 0; i < 3; i++) {
      muitos.push({ data: dia, hora: `0${i + 8}:00`, titulo: `Compromisso número ${i + 1} do dia`, local: 'Consultório central' });
    }
  }
  const r = montarAgenda({ compromissos: muitos, hojeStr, titulo: '📅 *Próximos compromissos*' });
  if (r.texto.length > 1024) falhas.push(`⚠️ §3 ESTOUROU o limite: ${r.texto.length} caracteres`);
  if (r.ocultos <= 0) falhas.push('§3 deveria informar quantos ficaram de fora');
  if (!/e mais \d+ compromissos/.test(r.texto)) falhas.push('§3 o texto tem de dizer que há mais');
  if (r.mostrados >= muitos.length) falhas.push('§3 não deveria caber tudo');

  // ⚠️ O CORTE É POR DIA INTEIRO. Um dia pela metade faria a pessoa acreditar
  // que aquilo é tudo o que ela tem naquela data.
  const linhas = r.texto.split('\n');
  const ultimoDiaMostrado = [...linhas].reverse().find((l) => /^\*/.test(l));
  const itensDesseDia = muitos.filter((c) => r.texto.includes(c.titulo)).length;
  if (itensDesseDia % 3 !== 0) falhas.push('⚠️ §3 cortou no meio de um dia');
  if (!ultimoDiaMostrado) falhas.push('§3 deveria haver pelo menos um dia');

  // ⚠️ O RODAPÉ TAMBÉM OCUPA ESPAÇO, e é ele que aperta o limite.
  // Com blocos GRANDES sempre sobra folga e o rodapé cabe por acaso; o aperto
  // só aparece com blocos pequenos, que preenchem a mensagem quase até a borda
  // antes de o corte acontecer. Sem reservar espaço pro "…e mais N", a
  // mensagem volta a estourar — e a Cloud API corta em silêncio.
  const curtinhos = [];
  for (let d = 0; d < 60; d++) {
    curtinhos.push({ data: somarDias(hojeStr, d), hora: '08:00', titulo: 'Ir', local: null });
  }
  const c = montarAgenda({ compromissos: curtinhos, hojeStr, titulo: '📅 *Agenda*' });
  if (c.texto.length > 1024) {
    falhas.push(`⚠️ §3 com blocos curtos ESTOUROU: ${c.texto.length} caracteres (o rodapé não coube)`);
  }
  if (!/e mais \d+/.test(c.texto)) falhas.push('§3 blocos curtos também precisam avisar o que sobrou');
}
console.log('  ok');

console.log('── 4. o caso normal continua inteiro ──');
{
  const hojeStr = '2026-09-30';
  const poucos = [
    { data: '2026-09-30', hora: '14:00', titulo: 'Dentista', local: null },
    { data: '2026-10-01', hora: null,    titulo: 'Aniversário da Ana', local: null },
    { data: '2026-10-15', hora: '09:30', titulo: 'Reunião', local: 'Escritório' },
  ];
  const r = montarAgenda({ compromissos: poucos, hojeStr, titulo: '📅 *Próximos compromissos*' });
  eq(r.ocultos, 0, '§4 nada é cortado');
  eq(r.mostrados, 3, '§4 os três aparecem');
  if (!r.texto.includes('Hoje')) falhas.push('§4 hoje é rotulado como "Hoje"');
  if (!r.texto.includes('Amanhã')) falhas.push('§4 amanhã é rotulado como "Amanhã"');
  if (!r.texto.includes('dia todo')) falhas.push('§4 sem hora vira "dia todo"');
  if (!r.texto.includes('📍 Escritório')) falhas.push('§4 local aparece');
  if (/e mais/.test(r.texto)) falhas.push('§4 não deve prometer mais nada');
}
console.log('  ok');

console.log('── 5. ⚠️ FUSO: o dia é o de SÃO PAULO, não o do servidor ──');
{
  // O Render roda em UTC. Às 23h30 de 30/09 em SP já é 01/10 em UTC — e a
  // agenda passava a esconder o que a pessoa ainda tem HOJE à noite.
  eq(hojeSP(new Date('2026-10-01T02:30:00Z')), '2026-09-30',
     '⚠️ §5 23h30 em SP ainda é dia 30');
  eq(hojeSP(new Date('2026-09-30T23:30:00Z')), '2026-09-30',
     '§5 20h30 em SP é dia 30');
  // Virou o dia em SP (00:30 de 01/10 = 03:30 UTC).
  eq(hojeSP(new Date('2026-10-01T03:30:00Z')), '2026-10-01', '§5 depois da meia-noite em SP');

  // A janela fecha 30 dias à frente, sem escorregar de mês.
  const j = janela(30, new Date('2026-10-01T02:30:00Z'));
  eq(j.de, '2026-09-30', '§5 janela começa hoje em SP');
  eq(j.ate, '2026-10-30', '§5 …e termina 30 dias depois');
  eq(janela(0, new Date('2026-10-01T02:30:00Z')).ate, '2026-09-30', '§5 "hoje" é o mesmo dia');
}
console.log('  ok');

console.log('── 6. somarDias atravessa mês, ano e fevereiro ──');
{
  eq(somarDias('2026-09-30', 30), '2026-10-30', '§6 vira o mês');
  eq(somarDias('2026-12-20', 30), '2027-01-19', '§6 vira o ano');
  eq(somarDias('2028-02-01', 30), '2028-03-02', '§6 fevereiro bissexto');
  eq(somarDias('2026-10-15', 0), '2026-10-15', '§6 zero dias');
}
console.log('  ok');

console.log('── 7. ⚠️ O RESULTADO NÃO PODE DEPENDER DO FUSO DO PROCESSO ──');
{
  // O Render roda em UTC hoje, mas "hoje" é uma configuração de servidor, não
  // uma garantia. Aritmética de data ancorada em meia-noite LOCAL escorrega um
  // dia em qualquer fuso positivo (Europe/Berlin é UTC+2): `new Date(2026,8,30)`
  // vira 22:00 UTC do dia 29, e a agenda começaria um dia antes.
  //
  // Rodar em subprocesso é o único jeito de provar — `TZ` é lido uma vez, no
  // boot do processo.
  const { execFileSync } = require('child_process');
  const codigo = `
    const { somarDias, hojeSP } = require('./src/services/agendaWhatsapp');
    const r = [
      somarDias('2026-09-30', 30),
      somarDias('2026-12-20', 30),
      somarDias('2026-10-15', 0),
      hojeSP(new Date('2026-10-01T02:30:00Z')),
    ].join('|');
    process.stdout.write(r);
  `;
  const esperado = '2026-10-30|2027-01-19|2026-10-15|2026-09-30';
  for (const tz of ['UTC', 'Europe/Berlin', 'America/Sao_Paulo', 'Pacific/Kiritimati']) {
    let saida = '';
    try {
      saida = execFileSync(process.execPath, ['-e', codigo], {
        cwd: require('path').resolve(__dirname, '..'),
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      }).trim();
    } catch (e) { saida = `ERRO: ${e.message}`; }
    eq(saida, esperado, `⚠️ §7 mesmo resultado em TZ=${tz}`);
  }
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ agendaWhatsapp: todos os casos passaram');
