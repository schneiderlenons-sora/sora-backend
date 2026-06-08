const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const handleSaude   = require('./saude');
const handleEstudos = require('./estudos');

const HUMORES = {
  'otimo': 5, 'ótimo': 5, 'feliz': 5, 'maravilhoso': 5, 'incrivel': 5, 'incrível': 5,
  'bem': 4, 'bom': 4, 'tranquilo': 4, 'tranquila': 4, 'animado': 4, 'animada': 4,
  'mais ou menos': 3, 'normal': 3, 'ok': 3, 'medio': 3,
  'mal': 2, 'triste': 2, 'ansioso': 2, 'ansiosa': 2, 'estressado': 2, 'estressada': 2, 'cansado': 2, 'cansada': 2,
  'pessimo': 1, 'péssimo': 1, 'horrivel': 1, 'horrível': 1, 'deprimido': 1, 'deprimida': 1,
};

async function calcularStreak(habitoId) {
  const { data } = await supabase.from('registros_habito')
    .select('data, concluido').eq('habito_id', habitoId).eq('concluido', true)
    .order('data', { ascending: false }).limit(60);
  if (!data?.length) return 0;
  let streak = 0;
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  for (let i = 0; i < data.length; i++) {
    const d = new Date(data[i].data + 'T12:00:00');
    const esperado = new Date(hoje); esperado.setDate(esperado.getDate() - i);
    if (d.toDateString() === esperado.toDateString()) streak++;
    else break;
  }
  return streak;
}

module.exports = async function handleGrow(mensagem, ctx) {
  const { phone, grupoId, user } = ctx;
  const msg = (mensagem || '').toLowerCase().trim();

  // Tenta primeiro o handler de Saúde (medicamentos, peso, água, treino, consultas).
  // Se reconheceu o comando, retorna. Senão, segue pra outros padrões do Grow.
  const tratouSaude = await handleSaude(mensagem, ctx);
  if (tratouSaude) return;

  // Depois Estudos (estudei X 1h, minhas provas, tirei nota, streak)
  const tratouEstudos = await handleEstudos(mensagem, ctx);
  if (tratouEstudos) return;

  // ── LISTAR (hábitos / tarefas / compras) ────────────────────────────
  if (/^(meus\s+habitos|habitos|meus\s+hábitos|hábitos)$/i.test(msg)) {
    const { data: habitos } = await supabase.from('habitos')
      .select('id, nome, icone').eq('grupo_id', grupoId).eq('ativo', true);
    if (!habitos?.length) {
      await enviarTexto(phone, '🌱 Voce ainda nao tem habitos cadastrados. Crie no painel Grow ou diga: *novo habito beber agua*');
      return;
    }
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: regs } = await supabase.from('registros_habito')
      .select('habito_id, concluido').eq('grupo_id', grupoId).eq('data', hoje);
    const concluidos = new Set((regs || []).filter(r => r.concluido).map(r => r.habito_id));
    const linhas = habitos.map(h => `${concluidos.has(h.id) ? '✅' : '⬜'} ${h.icone} ${h.nome}`);
    await enviarTexto(phone, `🌱 *Seus habitos de hoje*\n\n${linhas.join('\n')}\n\nPara marcar: *fiz [nome do habito]*`);
    return;
  }

  if (/^(minhas\s+tarefas|tarefas|todo|todos)$/i.test(msg)) {
    const { data: tarefas } = await supabase.from('tarefas')
      .select('titulo, prioridade').eq('grupo_id', grupoId).eq('concluida', false)
      .order('created_at', { ascending: false }).limit(15);
    if (!tarefas?.length) {
      await enviarTexto(phone, '✨ Nenhuma tarefa pendente! Voce esta em dia.');
      return;
    }
    const priIcon = { urgente: '🔴', alta: '🟠', media: '🟡', baixa: '🟢' };
    const linhas = tarefas.map(t => `${priIcon[t.prioridade] || '🟡'} ${t.titulo}`);
    await enviarTexto(phone, `📋 *Tarefas pendentes* (${tarefas.length})\n\n${linhas.join('\n')}\n\nPara criar: *tarefa [titulo]*`);
    return;
  }

  if (/^(lista\s+de\s+compras|minha\s+lista|compras)$/i.test(msg)) {
    const { data: lista } = await supabase.from('listas_compras')
      .select('id').eq('grupo_id', grupoId).eq('ativa', true).maybeSingle();
    if (!lista) { await enviarTexto(phone, '🛒 Lista vazia. Adicione: *comprar leite*'); return; }
    const { data: itens } = await supabase.from('itens_lista_compras')
      .select('nome, quantidade, comprado').eq('lista_id', lista.id)
      .order('comprado').order('created_at', { ascending: false });
    if (!itens?.length) { await enviarTexto(phone, '🛒 Lista vazia. Adicione: *comprar leite*'); return; }
    const linhas = itens.map(i => `${i.comprado ? '✅' : '⬜'} ${i.nome}${i.quantidade && i.quantidade !== '1' ? ` (${i.quantidade})` : ''}`);
    const pendentes = itens.filter(i => !i.comprado).length;
    await enviarTexto(phone, `🛒 *Lista de compras* (${pendentes} pendente${pendentes === 1 ? '' : 's'})\n\n${linhas.join('\n')}`);
    return;
  }

  // ── CRIAR HABITO ────────────────────────────────────────────────────
  let m;
  if ((m = msg.match(/^(?:novo|criar|adicionar)\s+h[aá]bito\s+(.+)$/i))) {
    const nome = m[1].trim();
    const { data: h } = await supabase.from('habitos').insert({
      grupo_id: grupoId, nome, icone: '🎯', cor: '#7c3aed',
    }).select().single();
    await enviarTexto(phone, `🌱 *Habito criado!*\n\n🎯 ${h.nome}\n\nPara marcar como feito hoje: *fiz ${nome}*`);
    return;
  }

  // ── MARCAR TODOS OS HABITOS DE HOJE ─────────────────────────────────
  // Vem ANTES do "fiz [nome]" pra "fiz todos" não cair na busca por nome.
  if (/^(?:fiz|completei|conclu[ií]|terminei|marquei|fechei)\s+(?:todos?|tudo)(?:\s+(?:os\s+)?h[aá]bitos?)?(?:\s+(?:de\s+)?hoje)?$/i.test(msg)) {
    const diaSemana = (() => { const j = new Date().getDay(); return j === 0 ? 7 : j; })();
    const { data: habitos } = await supabase.from('habitos')
      .select('id, nome, icone, dias_semana').eq('grupo_id', grupoId).eq('ativo', true);
    const doDia = (habitos || []).filter(h => (h.dias_semana || [1,2,3,4,5,6,7]).includes(diaSemana));
    if (!doDia.length) {
      await enviarTexto(phone, '🌱 Voce nao tem habitos pra hoje. Crie no painel ou diga: *novo habito beber agua*');
      return;
    }
    const hoje = new Date().toISOString().slice(0, 10);
    await supabase.from('registros_habito').upsert(
      doDia.map(h => ({ habito_id: h.id, grupo_id: grupoId, data: hoje, concluido: true })),
      { onConflict: 'habito_id,data' }
    );
    const lista = doDia.map(h => `✅ ${h.icone} ${h.nome}`).join('\n');
    await enviarTexto(phone, `🎉 *${doDia.length} habito${doDia.length === 1 ? '' : 's'} de hoje marcado${doDia.length === 1 ? '' : 's'}!*\n\n${lista}\n\nMandou bem! 💪`);
    return;
  }

  // ── MARCAR HABITO COMO FEITO ────────────────────────────────────────
  if ((m = msg.match(/^(?:fiz|completei|conclu[ií]|terminei|marquei)\s+(.+)$/i))) {
    const termo = m[1].trim();
    const { data: habitos } = await supabase.from('habitos')
      .select('id, nome, icone').eq('grupo_id', grupoId).eq('ativo', true)
      .ilike('nome', `%${termo}%`);
    if (!habitos?.length) {
      await enviarTexto(phone, `❌ Nao encontrei habito com *"${termo}"*.\nCrie com: *novo habito ${termo}*`);
      return;
    }
    if (habitos.length > 1) {
      const lista = habitos.map(h => `• ${h.icone} ${h.nome}`).join('\n');
      await enviarTexto(phone, `🤔 Mais de um habito com *"${termo}"*:\n${lista}\n\nSeja mais especifico.`);
      return;
    }
    const habito = habitos[0];
    const hoje = new Date().toISOString().slice(0, 10);
    await supabase.from('registros_habito').upsert(
      { habito_id: habito.id, grupo_id: grupoId, data: hoje, concluido: true },
      { onConflict: 'habito_id,data' }
    );
    const streak = await calcularStreak(habito.id);
    const cauda = streak >= 30 ? ` 🏆 *${streak} dias seguidos!* Voce e uma maquina!`
              : streak >= 14 ? ` 🔥 *${streak} dias seguidos!* Imparavel!`
              : streak >= 7  ? ` 🔥 *${streak} dias seguidos!*`
              : streak > 1   ? ` Sequencia: ${streak} dias!`
              : '';
    await enviarTexto(phone, `✅ *${habito.icone} ${habito.nome}* concluido hoje!${cauda}`);
    return;
  }

  // ── CRIAR TAREFA ────────────────────────────────────────────────────
  if ((m = msg.match(/^(?:tarefa|todo|lembrar\s+de|preciso|anota[r]?\s+tarefa)\s+(.+)$/i))) {
    const titulo = m[1].trim();
    let prioridade = 'media';
    if (/urgente|urgent[ií]ssim/i.test(titulo)) prioridade = 'urgente';
    else if (/importante|prioridade\s+alta/i.test(titulo)) prioridade = 'alta';
    const { data: t } = await supabase.from('tarefas').insert({
      grupo_id: grupoId, titulo, prioridade, criado_por: user.id,
    }).select().single();
    const priLabel = { urgente: ' 🔴 URGENTE', alta: ' 🟠 Alta prioridade', media: '', baixa: ' 🟢' };
    await enviarTexto(phone, `📋 *Tarefa criada*${priLabel[prioridade]}\n\n${t.titulo}\n\nVer todas: *tarefas*`);
    return;
  }

  // ── REGISTRAR HUMOR ─────────────────────────────────────────────────
  if ((m = msg.match(/(?:me\s+sinto|estou|to|tô|hoje\s+estou|hoje\s+to)\s+(.+)/i))) {
    const palavra = m[1].trim().toLowerCase().split(/[\s.,!]/)[0];
    let humor = HUMORES[palavra] || HUMORES[m[1].trim().toLowerCase()] || null;
    if (humor == null) {
      for (const k of Object.keys(HUMORES)) {
        if (m[1].toLowerCase().includes(k)) { humor = HUMORES[k]; break; }
      }
    }
    if (humor != null) {
      const hoje = new Date().toISOString().slice(0, 10);
      await supabase.from('registros_humor').upsert({
        grupo_id: grupoId, user_id: user.id, data: hoje, humor, nota: mensagem,
      }, { onConflict: 'grupo_id,user_id,data' });
      const r = humor >= 4 ? '😊 Que bom saber! Continue cuidando de voce.'
            : humor === 3 ? '😐 Tudo passa. Tenha um bom dia!'
            : '💜 Sinto muito. Lembre-se: nao precisa estar bem o tempo todo. Cuide-se.';
      await enviarTexto(phone, `${r}\n\n📊 Humor registrado: ${'⭐'.repeat(humor)}${'☆'.repeat(5 - humor)} (${humor}/5)`);
      return;
    }
  }

  // ── LISTA DE COMPRAS ────────────────────────────────────────────────
  if ((m = msg.match(/^(?:comprar|adicionar\s+na\s+lista|lista)\s+(.+)$/i))) {
    const item = m[1].trim();
    const { data: existing } = await supabase.from('listas_compras')
      .select('id').eq('grupo_id', grupoId).eq('ativa', true).maybeSingle();
    let listaId = existing?.id;
    if (!listaId) {
      const { data: nova } = await supabase.from('listas_compras')
        .insert({ grupo_id: grupoId }).select('id').single();
      listaId = nova.id;
    }
    await supabase.from('itens_lista_compras').insert({ lista_id: listaId, nome: item });
    await enviarTexto(phone, `🛒 *"${item}"* adicionado a lista!\n\nVer tudo: *lista de compras*`);
    return;
  }

  // ── FALLBACK ────────────────────────────────────────────────────────
  await enviarTexto(phone,
    `🌱 *Sora Grow*\n\n` +
    `Nao entendi. Exemplos:\n\n` +
    `🎯 *fiz academia* — marca habito como feito\n` +
    `📋 *tarefa ligar pro medico* — cria tarefa\n` +
    `🛒 *comprar leite* — adiciona na lista\n` +
    `💭 *me sinto bem hoje* — registra humor\n` +
    `📊 *habitos* / *tarefas* / *lista de compras* — listar\n\n` +
    `🌐 Painel completo: https://www.forsora.com/grow/dashboard`
  );
};
