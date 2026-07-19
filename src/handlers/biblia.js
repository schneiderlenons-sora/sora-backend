// ─────────────────────────────────────────────────────────────────
// Bíblia no WhatsApp — LOCAL-FIRST (sem IA). capturaBiblia(msg, ctx) devolve
// true só quando reconhece um comando de Bíblia; senão false (segue o fluxo).
//
// ⚠️ GATILHOS FORTES E EXCLUSIVOS pra NÃO colidir com outras áreas:
//   • "versícul…" / "palavra do dia"          → versículo do dia
//   • "leitura de hoje" / "plano de leitura"   → status do plano
//   • "terminei/li a leitura de hoje"          → marca o dia do plano
//   • "li <Livro> <cap>" (livro reconhecido + número) → registra leitura avulsa
// Roda DEPOIS do capturaRapida (nota/tarefa) e ANTES da Agenda/IA.
// ─────────────────────────────────────────────────────────────────
const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');
const { LIVROS, planoPorId, diasDoPlano, versiculoDoDia } = require('../data/biblia');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const hojeISO = () => new Date().toISOString().slice(0, 10);

// "li joão 3", "acabei de ler salmos 23" → { referencia } | null.
// Exige LIVRO reconhecido + NÚMERO de capítulo (reduz falso positivo do "li").
function extrairLeitura(n) {
  const m = n.match(/^(?:li|acabei de ler|terminei de ler|terminei a leitura de|conclui a leitura de)\s+(.+)$/);
  if (!m) return null;
  const resto = m[1];
  // acha o livro (mais longo primeiro pra pegar "1 joao" antes de "joao")
  const livro = [...LIVROS].sort((a, b) => b.length - a.length).find(l => resto.startsWith(l + ' ') || resto === l);
  if (!livro) return null;
  const aposLivro = resto.slice(livro.length).trim();
  const cap = aposLivro.match(/^(\d+)(?:[:\-–]\d+)?/);
  if (!cap) return null; // sem capítulo → não é leitura bíblica clara
  // rótulo bonito: capitaliza o livro
  const livroLabel = livro.replace(/\b\w/g, c => c.toUpperCase());
  return { referencia: `${livroLabel} ${aposLivro}`.trim() };
}

async function capturaBiblia(mensagem, ctx) {
  const { phone, grupoId, user } = ctx;
  const n = norm(mensagem);
  if (!n) return false;

  // Opt-in/out do versículo diário. ATIVAR exige intenção RECORRENTE (senão
  // "me manda a palavra do dia" seria um pedido único, tratado mais abaixo).
  const temVersicRef  = /versicul|palavra do dia/.test(n);
  const recorrente    = /(todo dia|todos os dias|diariamente|toda manh[a]|todas as manh)/.test(n);
  const querDesativar = temVersicRef && /(desativar|parar|cancelar|nao quero|para de|chega de)/.test(n);
  const querAtivar    = temVersicRef && !querDesativar && (/ativar|quero receber|passar a receber|me inscrev/.test(n) || recorrente);
  if (querDesativar) {
    await supabase.from('users').update({ biblia_versiculo_ativo: false }).eq('id', user.id);
    await enviarTexto(phone, '🔕 Ok! Não te mando mais o versículo do dia. Pra voltar, é só dizer *ativar versículo diário*.');
    return true;
  }
  if (querAtivar) {
    await supabase.from('users').update({ biblia_versiculo_ativo: true }).eq('id', user.id);
    const v = versiculoDoDia();
    await enviarTexto(phone, `🙏 Feito! Todo dia de manhã eu te mando um versículo. Começando por hoje:\n\n_"${v.texto}"_\n*${v.ref}*\n\n(Pra parar: *desativar versículo diário*.)`);
    return true;
  }

  const ehVersiculo = /\bversicul|palavra do dia/.test(n);
  const ehStatusPlano = /(leitura de hoje|plano de leitura|plano biblic|leitura biblic)/.test(n) && !/terminei|conclui|marcar|fiz|acabei|^li /.test(n);
  const ehMarcarHoje  = /(terminei|conclui|acabei|fiz|marcar|li)\s+(a\s+)?leitura de hoje|(terminei|fiz)\s+(o\s+)?plano de hoje/.test(n);
  const leituraLivre  = extrairLeitura(n);

  if (!ehVersiculo && !ehStatusPlano && !ehMarcarHoje && !leituraLivre) return false;

  // ── Versículo do dia ──
  if (ehVersiculo) {
    const v = versiculoDoDia();
    await enviarTexto(phone, `📖 *Versículo do dia*\n\n_"${v.texto}"_\n\n*${v.ref}*\n\nBom dia na Palavra! 🙏`);
    return true;
  }

  // Plano ativo (pros comandos de plano).
  const { data: prog } = await supabase.from('biblia_progresso').select('plano_id, iniciado_em').eq('user_id', user.id).maybeSingle();
  const plano = planoPorId(prog?.plano_id);

  // ── Status do plano / leitura de hoje ──
  if (ehStatusPlano) {
    if (!plano) { await enviarTexto(phone, '📖 Você ainda não tem um plano de leitura ativo. Escolha um no painel → *Grow › Estudos › Bíblia*. 🙂'); return true; }
    const dias = diasDoPlano(plano);
    const { data: feitas } = await supabase.from('biblia_leituras').select('dia').eq('user_id', user.id).eq('plano_id', plano.id).not('dia', 'is', null);
    const feitosSet = new Set((feitas || []).map(f => f.dia));
    const proximo = dias.find(d => !feitosSet.has(d.dia));
    const pct = Math.round((feitosSet.size / dias.length) * 100);
    if (!proximo) { await enviarTexto(phone, `🎉 Você concluiu o plano *${plano.nome}*! Escolha outro no painel pra continuar.`); return true; }
    await enviarTexto(phone,
      `📖 *${plano.nome}*\nProgresso: *${pct}%* (dia ${feitosSet.size + 1} de ${dias.length})\n\n*Leitura de hoje:* ${proximo.referencia}\n\nQuando ler, responda *terminei a leitura de hoje*.`);
    return true;
  }

  // ── Marcar a leitura do plano como lida ──
  if (ehMarcarHoje) {
    if (!plano) { await enviarTexto(phone, '📖 Você não tem um plano ativo. Escolha um em *Grow › Estudos › Bíblia*.'); return true; }
    const dias = diasDoPlano(plano);
    const { data: feitas } = await supabase.from('biblia_leituras').select('dia').eq('user_id', user.id).eq('plano_id', plano.id).not('dia', 'is', null);
    const feitosSet = new Set((feitas || []).map(f => f.dia));
    const proximo = dias.find(d => !feitosSet.has(d.dia));
    if (!proximo) { await enviarTexto(phone, `🎉 Esse plano já está concluído! Escolha outro no painel.`); return true; }
    const { error } = await supabase.from('biblia_leituras').insert({
      grupo_id: grupoId, user_id: user.id, data: hojeISO(),
      plano_id: plano.id, dia: proximo.dia, referencia: proximo.referencia, duracao_min: 0,
    });
    if (error && error.code !== '23505') { await enviarTexto(phone, '😕 Não consegui registrar agora. Tenta de novo em instantes.'); return true; }
    const restam = dias.length - (feitosSet.size + 1);
    const seguinte = dias[proximo.dia]; // próximo após o que acabou de marcar
    await enviarTexto(phone,
      `✅ *${proximo.referencia}* marcado como lido!${restam > 0 ? `\nFaltam *${restam}* dia${restam > 1 ? 's' : ''}.` : '\n🎉 Plano concluído, parabéns!'}` +
      (seguinte ? `\n\n*Amanhã:* ${seguinte.referencia}` : ''));
    return true;
  }

  // ── Leitura avulsa ("li João 3") ──
  if (leituraLivre) {
    const { error } = await supabase.from('biblia_leituras').insert({
      grupo_id: grupoId, user_id: user.id, data: hojeISO(), referencia: leituraLivre.referencia, duracao_min: 0,
    });
    if (error) { await enviarTexto(phone, '😕 Não consegui registrar a leitura agora. Tenta de novo.'); return true; }
    await enviarTexto(phone, `✅ Leitura registrada: *${leituraLivre.referencia}*.\nQue a Palavra fique no coração! 🙏`);
    return true;
  }

  return false;
}

module.exports = { capturaBiblia };
