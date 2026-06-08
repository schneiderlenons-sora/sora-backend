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

async function getOrCreateLista(grupoId) {
  const { data: existing } = await supabase.from('listas_compras')
    .select('id').eq('grupo_id', grupoId).eq('ativa', true).maybeSingle();
  if (existing) return existing.id;
  const { data: nova } = await supabase.from('listas_compras')
    .insert({ grupo_id: grupoId }).select('id').single();
  return nova.id;
}

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

  let m;

  // ── MANUTENÇÕES: listar ─────────────────────────────────────────────
  if (/^(minhas\s+manuten[çc][õo]es|manuten[çc][õo]es|manuten[çc][aã]o)$/i.test(msg)) {
    const { data: mans } = await supabase.from('manutencoes')
      .select('nome, icone, frequencia_dias, ultima_data').eq('grupo_id', grupoId);
    if (!mans?.length) {
      await enviarTexto(phone, '🔧 Nenhuma manutenção cadastrada. Adicione no painel: *Casa → Manutenções*.');
      return;
    }
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const linhas = mans.map(mn => {
      let dias = 0;
      if (mn.ultima_data) {
        const prox = new Date(mn.ultima_data + 'T12:00:00');
        prox.setDate(prox.getDate() + (mn.frequencia_dias || 90));
        prox.setHours(0, 0, 0, 0);
        dias = Math.round((prox - hoje) / 86400000);
      }
      const ic = !mn.ultima_data ? '🆕' : dias < 0 ? '🔴' : dias <= 7 ? '🟡' : '🟢';
      const txt = !mn.ultima_data ? 'nunca feita' : dias < 0 ? `atrasada ${-dias}d` : dias === 0 ? 'vence hoje' : `em ${dias}d`;
      return `${ic} ${mn.icone || '🔧'} ${mn.nome} — ${txt}`;
    });
    await enviarTexto(phone, `🔧 *Manutenções da casa*\n\n${linhas.join('\n')}\n\nPra marcar feita: *fiz a manutenção [nome]*`);
    return;
  }

  // ── MANUTENÇÕES: marcar feita (antes do "fiz X" de hábitos) ──────────
  if ((m = msg.match(/^(?:fiz|fa[çc]o|completei|realizei)\s+(?:a\s+)?manuten[çc][aã]o\s+(?:d[eoa]s?\s+)?(.+)$/i))) {
    const termo = m[1].trim();
    const { data: achados } = await supabase.from('manutencoes')
      .select('id, nome, icone, frequencia_dias').eq('grupo_id', grupoId).ilike('nome', `%${termo}%`);
    if (!achados?.length) {
      await enviarTexto(phone, `❌ Não encontrei manutenção com *"${termo}"*. Cadastre no painel: *Casa → Manutenções*.`);
      return;
    }
    const man = achados[0];
    const hojeStr = new Date().toISOString().slice(0, 10);
    await supabase.from('manutencoes').update({ ultima_data: hojeStr, lembrete_ultimo: null }).eq('id', man.id);
    const prox = new Date(); prox.setDate(prox.getDate() + (man.frequencia_dias || 90));
    await enviarTexto(phone, `✅ *${man.icone || '🔧'} ${man.nome}* marcada como feita hoje!\n\n📅 Próxima: ${prox.toLocaleDateString('pt-BR')}`);
    return;
  }

  // ── CRIAR HABITO ────────────────────────────────────────────────────
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

  // ── DESPENSA: listar status ─────────────────────────────────────────
  if (/^(minha\s+despensa|despensa|o\s+que\s+(t[aá]|est[aá])\s+acabando|que\s+falta\s+em\s+casa)$/i.test(msg)) {
    const { data: itens } = await supabase.from('despensa_itens')
      .select('nome, status').eq('grupo_id', grupoId);
    if (!itens?.length) {
      await enviarTexto(phone, '🧺 Sua despensa está vazia. Cadastre o que costuma ter em casa no painel, ou diga *acabou o café* que eu já começo a montar.');
      return;
    }
    const ic = { tem: '✅', acabando: '🟡', acabou: '🔴' };
    const ordem = { acabou: 0, acabando: 1, tem: 2 };
    const linhas = itens
      .sort((a, b) => (ordem[a.status] ?? 3) - (ordem[b.status] ?? 3))
      .map(i => `${ic[i.status] || '•'} ${i.nome}`);
    const faltando = itens.filter(i => i.status !== 'tem').length;
    await enviarTexto(phone, `🧺 *Sua despensa*\n\n${linhas.join('\n')}\n\n${faltando ? `🛒 ${faltando} item(ns) na lista de compras` : 'Tudo abastecido! 🎉'}`);
    return;
  }

  // ── DESPENSA: marcar acabou / acabando ──────────────────────────────
  if ((m = msg.match(/^(?:acabou|acabando|t[aá]\s+acabando|est[aá]\s+acabando)\s+(?:o|a|os|as)\s+(.+)$/i))
    || (m = msg.match(/^(?:acabou|acabando)\s+(.+)$/i))) {
    const termo = m[1].trim();
    const novoStatus = /acabando/i.test(msg) ? 'acabando' : 'acabou';
    let { data: achados } = await supabase.from('despensa_itens')
      .select('id, nome').eq('grupo_id', grupoId).ilike('nome', `%${termo}%`);
    let item;
    if (achados?.length) {
      item = achados[0];
      await supabase.from('despensa_itens')
        .update({ status: novoStatus, updated_at: new Date().toISOString() }).eq('id', item.id);
    } else {
      const { data: novo } = await supabase.from('despensa_itens')
        .insert({ grupo_id: grupoId, nome: termo, status: novoStatus }).select().single();
      item = novo;
    }
    // Garante na lista de compras (linkado, sem duplicar)
    const listaId = await getOrCreateLista(grupoId);
    const { data: jaTem } = await supabase.from('itens_lista_compras')
      .select('id').eq('lista_id', listaId).eq('despensa_item_id', item.id).eq('comprado', false).maybeSingle();
    if (!jaTem) {
      await supabase.from('itens_lista_compras')
        .insert({ lista_id: listaId, nome: item.nome, despensa_item_id: item.id });
    }
    await enviarTexto(phone, `🛒 *${item.nome}* ${novoStatus === 'acabando' ? 'tá acabando' : 'acabou'} — já coloquei na lista de compras!\n\nVer lista: *lista de compras*`);
    return;
  }

  // ── RECEITAS: o que dá pra cozinhar com o que tem em casa ───────────
  if (/^(?:o\s+que\s+(?:eu\s+)?(?:posso|d[aá]\s+(?:pra?|para))\s+cozinhar|o\s+que\s+(?:eu\s+)?fa[çc]o\s+(?:pra?|para)\s+(?:comer|jantar|almo[çc]ar)|sugest[ãa]o\s+de\s+receita)/i.test(msg)) {
    const { data: receitas } = await supabase.from('receitas')
      .select('id, nome, icone').eq('grupo_id', grupoId);
    if (!receitas?.length) {
      await enviarTexto(phone, '🍳 Você ainda não cadastrou receitas. Crie no painel: *Casa → Receitas*.');
      return;
    }
    const { data: ings } = await supabase.from('receita_ingredientes')
      .select('receita_id, nome').in('receita_id', receitas.map(r => r.id));
    const { data: despensa } = await supabase.from('despensa_itens')
      .select('nome, status').eq('grupo_id', grupoId);
    const tem = (despensa || []).filter(d => d.status === 'tem').map(d => d.nome.toLowerCase());
    const temIng = nome => tem.some(t => t.includes(nome.toLowerCase()) || nome.toLowerCase().includes(t));
    const ranking = receitas.map(r => {
      const lista = (ings || []).filter(i => i.receita_id === r.id);
      const ok = lista.filter(i => temIng(i.nome)).length;
      return { r, ok, total: lista.length, falta: lista.length - lista.filter(i => temIng(i.nome)).length };
    }).filter(x => x.total > 0).sort((a, b) => a.falta - b.falta);
    if (!ranking.length) {
      await enviarTexto(phone, '🍳 Suas receitas estão sem ingredientes cadastrados. Adicione no painel: *Casa → Receitas*.');
      return;
    }
    const prontas = ranking.filter(x => x.falta === 0);
    const quase = ranking.filter(x => x.falta > 0 && x.falta <= 2);
    let txt = '🍳 *O que dá pra cozinhar*\n';
    if (prontas.length) txt += `\n✅ *Dá pra fazer agora:*\n${prontas.map(x => `${x.r.icone || '🍳'} ${x.r.nome}`).join('\n')}`;
    if (quase.length) txt += `\n\n🛒 *Quase lá (falta pouco):*\n${quase.map(x => `${x.r.icone || '🍳'} ${x.r.nome} — falta ${x.falta} item${x.falta === 1 ? '' : 's'}`).join('\n')}`;
    if (!prontas.length && !quase.length) txt += '\nNenhuma receita pronta com o que tem na despensa. Dá uma olhada na sua lista de compras! 🛒';
    txt += '\n\nPra cozinhar e mandar o que falta pra lista: *cozinhar [receita]*';
    await enviarTexto(phone, txt);
    return;
  }

  // ── RECEITAS: listar ────────────────────────────────────────────────
  if (/^(minhas\s+receitas|receitas)$/i.test(msg)) {
    const { data: receitas } = await supabase.from('receitas')
      .select('id, nome, icone, tempo_min, porcoes').eq('grupo_id', grupoId)
      .order('created_at', { ascending: false });
    if (!receitas?.length) {
      await enviarTexto(phone, '🍳 Você ainda não tem receitas. Cadastre no painel: *Casa → Receitas*.');
      return;
    }
    const linhas = receitas.map(r => {
      const meta = [r.tempo_min ? `${r.tempo_min}min` : null, r.porcoes ? `${r.porcoes} porç.` : null].filter(Boolean).join(' · ');
      return `${r.icone || '🍳'} ${r.nome}${meta ? ` — ${meta}` : ''}`;
    });
    await enviarTexto(phone, `🍳 *Suas receitas* (${receitas.length})\n\n${linhas.join('\n')}\n\nVer ingredientes: *receita [nome]*\nCozinhar: *cozinhar [nome]*`);
    return;
  }

  // ── RECEITAS: cozinhar (manda o que falta pra lista de compras) ─────
  if ((m = msg.match(/^(?:vou\s+cozinhar|cozinhar|fazer\s+(?:a\s+)?receita|preparar)\s+(.+)$/i))) {
    const termo = m[1].trim();
    const { data: achadas } = await supabase.from('receitas')
      .select('id, nome, icone').eq('grupo_id', grupoId).ilike('nome', `%${termo}%`);
    if (!achadas?.length) {
      await enviarTexto(phone, `❌ Não encontrei receita com *"${termo}"*. Veja as suas: *receitas*`);
      return;
    }
    const rec = achadas[0];
    const { data: ings } = await supabase.from('receita_ingredientes')
      .select('id, nome, quantidade, categoria').eq('receita_id', rec.id).order('ordem');
    if (!ings?.length) {
      await enviarTexto(phone, `🍳 *${rec.icone || '🍳'} ${rec.nome}* ainda não tem ingredientes cadastrados. Adicione no painel: *Casa → Receitas*.`);
      return;
    }
    const { data: despensa } = await supabase.from('despensa_itens')
      .select('id, nome, status').eq('grupo_id', grupoId);
    const acha = nome => (despensa || []).find(d => {
      const a = d.nome.toLowerCase(), b = nome.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    const listaId = await getOrCreateLista(grupoId);
    const adicionados = [], jaTem = [];
    for (const ing of ings) {
      const match = acha(ing.nome);
      if (match && match.status === 'tem') { jaTem.push(ing.nome); continue; }
      const { data: dup } = await supabase.from('itens_lista_compras')
        .select('id').eq('lista_id', listaId).ilike('nome', ing.nome).eq('comprado', false).maybeSingle();
      if (!dup) {
        await supabase.from('itens_lista_compras').insert({
          lista_id: listaId, nome: ing.nome, quantidade: ing.quantidade || '1',
          categoria: ing.categoria || null, despensa_item_id: match ? match.id : null,
        });
      }
      adicionados.push(ing.nome);
    }
    let txt = `🍳 *Bora cozinhar ${rec.nome}!*\n`;
    if (jaTem.length) txt += `\n✅ Você já tem: ${jaTem.join(', ')}`;
    if (adicionados.length) txt += `\n🛒 Adicionei à lista: ${adicionados.join(', ')}`;
    else txt += '\n\n🎉 Você tem tudo que precisa! Mãos à obra.';
    if (adicionados.length) txt += '\n\nVer lista: *lista de compras*';
    await enviarTexto(phone, txt);
    return;
  }

  // ── RECEITAS: ver uma receita (ingredientes + preparo) ──────────────
  if ((m = msg.match(/^(?:receita|como\s+(?:eu\s+)?(?:fa[çc]o|faz|se\s+faz)(?:\s+(?:o|a|os|as))?|ingredientes\s+(?:d[eoa]s?\s+)?)\s*(.+)$/i))) {
    const termo = m[1].trim();
    const { data: achadas } = await supabase.from('receitas')
      .select('id, nome, icone, tempo_min, porcoes, modo_preparo').eq('grupo_id', grupoId).ilike('nome', `%${termo}%`);
    if (!achadas?.length) {
      await enviarTexto(phone, `❌ Não encontrei receita com *"${termo}"*. Veja as suas: *receitas*`);
      return;
    }
    const rec = achadas[0];
    const { data: ings } = await supabase.from('receita_ingredientes')
      .select('nome, quantidade').eq('receita_id', rec.id).order('ordem');
    const meta = [rec.tempo_min ? `⏱️ ${rec.tempo_min}min` : null, rec.porcoes ? `🍽️ ${rec.porcoes} porç.` : null].filter(Boolean).join('  ');
    const listaIng = (ings || []).length
      ? (ings || []).map(i => `• ${i.nome}${i.quantidade ? ` — ${i.quantidade}` : ''}`).join('\n')
      : '_sem ingredientes cadastrados_';
    let txt = `${rec.icone || '🍳'} *${rec.nome}*${meta ? `\n${meta}` : ''}\n\n🧺 *Ingredientes:*\n${listaIng}`;
    if (rec.modo_preparo) txt += `\n\n👩‍🍳 *Preparo:*\n${rec.modo_preparo}`;
    txt += '\n\nPra cozinhar e mandar o que falta pra lista: *cozinhar ' + rec.nome.toLowerCase() + '*';
    await enviarTexto(phone, txt);
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
