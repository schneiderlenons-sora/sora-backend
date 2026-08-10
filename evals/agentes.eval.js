// =============================================================================
// EVAL da VOZ dos agentes.
//
// A voz ENVOLVE o texto do aviso (assinatura + abertura + texto + fecho) e
// nunca reescreve o miolo. Este eval existe pra garantir exatamente isso: um
// aviso financeiro que perde o valor ou a data na brincadeira é MUITO pior do
// que um aviso sem graça.
//
// O que está travado aqui:
//  · com AGENTES_VOZ desligado, a saída é IDÊNTICA à entrada (regressão zero);
//  · o texto original aparece inteiro dentro da mensagem vestida;
//  · o `core` (parâmetro de template da Meta) sai em UMA linha e dentro do
//    limite de tamanho — parâmetro com \n é REJEITADO pela Meta e o aviso
//    simplesmente não chega;
//  · aviso sem voz cadastrada não quebra: devolve o original.
//
// Rodar:  npm run eval:agentes
// =============================================================================
process.env.AGENTES_VOZ = '1';                    // liga a voz SÓ neste processo
const { falar, temVoz, AGENTES, VOZES } = require('../src/agentes');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── 1. Desligado = regressão zero ───────────────────────────────────────
// Roda o módulo num processo limpo, sem a env, e confere que nada muda.
console.log('── 1. voz desligada não muda nada ──');
{
  const { execFileSync } = require('child_process');
  const saida = execFileSync(process.execPath, ['-e', `
    delete process.env.AGENTES_VOZ;
    const { falar } = require('${require('path').resolve(__dirname, '../src/agentes').replace(/\\/g, '\\\\')}');
    const r = falar('don-baleone', 'dividas', { texto: 'ORIGINAL', core: 'CORE' });
    process.stdout.write(JSON.stringify(r));
  `], { encoding: 'utf8' });
  const r = JSON.parse(saida);
  ok(r.texto === 'ORIGINAL', `sem AGENTES_VOZ o texto sai intacto (veio "${r.texto}")`);
  ok(r.core === 'CORE', `sem AGENTES_VOZ o core sai intacto (veio "${r.core}")`);
}
console.log('  ok');

// ── 2. O texto original nunca se perde ──────────────────────────────────
console.log('── 2. o miolo do aviso sobrevive ──');
{
  const original = '🔔 *Lembrete de dívida*\n📌 *Empréstimo* (Nubank)\n💵 R$ 629,51\n📅 Vence em 3 dias';
  const r = falar('don-baleone', 'dividas', { texto: original, core: 'Empréstimo R$ 629,51 vence em 3 dias', seed: 'x' });
  ok(r.texto.includes(original), 'o texto original aparece INTEIRO na mensagem vestida');
  ok(r.texto.includes('629,51'), 'o valor sobrevive');
  ok(r.texto.includes('Don Baleone'), 'a mensagem é assinada pelo agente');
  ok(r.core.includes('629,51'), 'o valor também sobrevive no core do template');
  ok(r.texto !== original, 'e a mensagem realmente mudou (a voz entrou)');
}
console.log('  ok');

// ── 3. O core é parâmetro de template: UMA linha e com teto ─────────────
console.log('── 3. core válido pra Meta ──');
{
  for (const chave of Object.keys(VOZES)) {
    const [ag, av] = chave.split('.');
    const r = falar(ag, av, {
      texto: 'linha 1\nlinha 2',
      core: 'fato importante R$ 100,00',
      seed: 'eval',
    });
    ok(!/[\r\n\t]/.test(r.core), `${chave}: core não pode ter quebra de linha (a Meta rejeita)`);
    ok(r.core.length <= 1024, `${chave}: core dentro do limite da Meta (veio ${r.core.length})`);
    ok(r.core.includes('R$ 100,00'), `${chave}: o fato sobrevive no core`);
    ok(!/undefined|null|NaN/.test(r.texto), `${chave}: nunca vaza undefined/null no texto`);
    ok(!/undefined|null|NaN/.test(r.core), `${chave}: nunca vaza undefined/null no core`);
  }
}
console.log(`  ok (${Object.keys(VOZES).length} vozes conferidas)`);

// ── 4. Core gigante: corta a piada, nunca o fato ────────────────────────
console.log('── 4. aviso comprido não estoura o limite ──');
{
  const enorme = 'X'.repeat(880);
  const r = falar('don-baleone', 'limite', { texto: 't', core: enorme, seed: 'a' });
  ok(r.core.includes(enorme), 'o fato inteiro continua no core mesmo sendo enorme');
  ok(r.core.length <= 1024, `core segue dentro do limite (veio ${r.core.length})`);
}
console.log('  ok');

// ── 5. Aviso sem voz cadastrada não quebra ──────────────────────────────
console.log('── 5. agente/aviso desconhecido cai no original ──');
{
  const r = falar('inexistente', 'nada', { texto: 'T', core: 'C' });
  ok(r.texto === 'T' && r.core === 'C', 'agente desconhecido devolve o original');

  const r2 = falar('don-baleone', 'aviso-que-nao-existe', { texto: 'T', core: 'C' });
  ok(r2.texto === 'T' && r2.core === 'C', 'aviso sem voz devolve o original');

  ok(temVoz('don-baleone', 'dividas') === true, 'temVoz reconhece o que existe');
  ok(temVoz('don-baleone', 'xpto') === false, 'temVoz nega o que não existe');
}
console.log('  ok');

// ── 6. Toda voz tem um agente de verdade e variação suficiente ──────────
console.log('── 6. catálogo consistente ──');
{
  for (const chave of Object.keys(VOZES)) {
    const [ag] = chave.split('.');
    ok(!!AGENTES[ag], `${chave}: o agente "${ag}" existe no catálogo`);
    ok(VOZES[chave].abre.length >= 3, `${chave}: pelo menos 3 aberturas (senão vira ruído repetido)`);
    ok(VOZES[chave].fecha.length >= 3, `${chave}: pelo menos 3 fechos`);
  }
  // A mesma seed tem de dar sempre a mesma fala (previsível pra teste e evita
  // o mesmo aviso mudar de tom a cada tentativa de envio).
  const a = falar('aurora', 'habitos', { texto: 't', seed: 'u1' });
  const b = falar('aurora', 'habitos', { texto: 't', seed: 'u1' });
  ok(a.texto === b.texto, 'mesma seed = mesma fala');
  const c = falar('aurora', 'habitos', { texto: 't', seed: 'u2' });
  ok(a.texto !== c.texto || VOZES['aurora.habitos'].abre.length === 1,
    'seeds diferentes tendem a falas diferentes');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ voz dos agentes: todos os casos passaram');
