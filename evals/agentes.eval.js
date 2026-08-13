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
process.env.AGENTES_TEMPLATE = '1';               // e a fase 3 (template do agente)
process.env.NEXT_PUBLIC_APP_URL = 'https://www.forsora.com';
const { falar, temVoz, templateAgente, AGENTES, VOZES } = require('../src/agentes');

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
  const a = falar('loki', 'habitos', { texto: 't', seed: 'u1' });
  const b = falar('loki', 'habitos', { texto: 't', seed: 'u1' });
  ok(a.texto === b.texto, 'mesma seed = mesma fala');
  const c = falar('loki', 'habitos', { texto: 't', seed: 'u2' });
  ok(a.texto !== c.texto || VOZES['loki.habitos'].abre.length === 1,
    'seeds diferentes tendem a falas diferentes');
}
console.log('  ok');

// ── 7. Template com a cara do agente (fase 3) ───────────────────────────
console.log('── 7. template do agente ──');
{
  const t = templateAgente('don-baleone', 'Escuta aqui, chefe... R$ 629,51 vence em 3 dias.');
  ok(t !== null, 'com AGENTES_TEMPLATE=1 o template é montado');
  ok(t.name === 'agente_aviso', `nome do template (veio "${t.name}")`);
  ok(t.params.length === 2, `2 parâmetros: nome e recado (veio ${t.params.length})`);
  ok(t.params[0] === 'Don Baleone', `{{1}} é o NOME do agente (veio "${t.params[0]}")`);
  ok(t.params[1].includes('629,51'), '{{2}} carrega o recado com o valor');
  ok(!t.params[1].startsWith('Don Baleone'),
    'o recado NÃO repete o nome — ele já é o {{1}} (senão sai "Don Baleone: Don Baleone: ...")');
  // ⚠️ Pasta PRÓPRIA (`agentes/whatsapp/`), separada de `public/agentes/<id>.png`
  // (a arte do painel, 640×640 — poster do vídeo). A capa de mensagem é
  // 1200×630, o formato que a Meta espera pra cabeçalho — arquivo da pasta
  // errada não é "meio certo", é a Meta recusando a imagem inteira.
  ok(t.opts.headerImage === 'https://www.forsora.com/agentes/whatsapp/don-baleone.png',
    `capa aponta pro arquivo do agente, na pasta whatsapp/ (veio "${t.opts.headerImage}")`);

  // A imagem é parâmetro de ENVIO: cada agente manda a sua com o MESMO template.
  const t2 = templateAgente('dr-house', 'Dose das 14h.');
  ok(t2.name === t.name, 'todos os agentes usam UM template só (1 aprovação na Meta)');
  ok(t2.opts.headerImage !== t.opts.headerImage, 'mas cada um com a SUA capa');

  // Regras de parâmetro da Meta.
  for (const chave of Object.keys(VOZES)) {
    const [ag, av] = chave.split('.');
    const v = falar(ag, av, { texto: 'linha1\nlinha2', core: 'fato R$ 10,00', seed: 's' });
    const tpl = templateAgente(ag, v.coreAgente);
    ok(tpl !== null, `${chave}: template montado`);
    ok(!/[\r\n\t]/.test(tpl.params[1]), `${chave}: parâmetro sem quebra de linha (a Meta rejeita)`);
    ok(tpl.params[1].length <= 1024, `${chave}: parâmetro dentro do limite`);
    ok(tpl.params[1].includes('R$ 10,00'), `${chave}: o fato sobrevive`);
    // `(\?v=\d+)?` de propósito: `capaVersao` (ver catálogo) anexa `?v=N` pra
    // descachear uma URL que a Meta já tentou buscar e recusou antes.
    ok(/^https:\/\/.+\.png(\?v=\d+)?$/.test(tpl.opts.headerImage), `${chave}: capa é URL pública .png`);
  }

  ok(templateAgente('nao-existe', 'x') === null, 'agente desconhecido não monta template');
  ok(templateAgente('don-baleone', '') === null, 'recado vazio não monta template');

  // Este bloco cobre o caso `arte: false` — hoje os 8 têm arte, mas volta a
  // acontecer a cada agente NOVO (fase 4): apontar o cabeçalho pra um .png
  // inexistente faz a Meta RECUSAR a mensagem inteira, e o agente ficaria
  // mudo por falta de desenho.
  const semArte = templateAgente('__fantasma__', 'x');
  ok(semArte === null, 'agente que não existe no catálogo não monta template');

  // Simula um agente recém-criado, ainda sem arquivo de imagem.
  AGENTES.__novo__ = { nome: 'Novato', emoji: '🐣', arte: false };
  const novo = templateAgente('__novo__', 'Primeiro recado.');
  ok(novo !== null, 'agente sem arte ainda monta o template');
  ok(!novo.opts.headerImage.includes('__novo__'),
    `agente sem arte NÃO aponta pro png inexistente (veio "${novo.opts.headerImage}")`);
  ok(novo.opts.headerImage.includes('sora-capa'), 'ele cai na capa genérica da Sora');
  ok(novo.params[0] === 'Novato', 'e o nome dele continua no {{1}}');
  delete AGENTES.__novo__;

  // Os agentes COM arte apontam pro arquivo próprio, na pasta whatsapp/ — os
  // 8 hoje. O `else` cobre o dia em que um agente novo entrar sem arte ainda.
  for (const id of Object.keys(AGENTES)) {
    const t3 = templateAgente(id, 'recado');
    if (AGENTES[id].arte) {
      ok(t3.opts.headerImage.includes(`/agentes/whatsapp/${id}.png`),
        `${id}: usa a capa própria em whatsapp/ (veio "${t3.opts.headerImage}")`);
    } else {
      ok(t3.opts.headerImage.includes('sora-capa'),
        `${id}: sem arte, cai na capa genérica (veio "${t3.opts.headerImage}")`);
    }
  }
}
console.log('  ok');

// ── 8. Fase 3 desligada = template do agente nem aparece ────────────────
console.log('── 8. fase 3 desligada ──');
{
  const { execFileSync } = require('child_process');
  const mod = require('path').resolve(__dirname, '../src/agentes').replace(/\\/g, '\\\\');
  const saida = execFileSync(process.execPath, ['-e', `
    delete process.env.AGENTES_TEMPLATE;
    const { templateAgente } = require('${mod}');
    process.stdout.write(JSON.stringify(templateAgente('don-baleone', 'recado')));
  `], { encoding: 'utf8' });
  ok(saida === 'null', `sem AGENTES_TEMPLATE não monta template do agente (veio ${saida})`);
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
