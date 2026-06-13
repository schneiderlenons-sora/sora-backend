const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const { growShareCfg } = require('../services/growShare');
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

// ─── Parser PT de data/hora pra criar compromisso por linguagem natural ──
const isoD = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };

function proximoDiaSemana(alvo) { // alvo: 0=dom .. 6=sab
  const hoje = new Date(); hoje.setHours(12, 0, 0, 0);
  const delta = (alvo - hoje.getDay() + 7) % 7; // hoje se cair hoje
  const d = new Date(hoje); d.setDate(d.getDate() + delta); return d;
}

function parseDataPt(t) {
  const txt = ' ' + t.toLowerCase() + ' ';
  let m;
  if (/\bdepois de amanh[ãa](?=\W|$)/.test(txt)) { const d = new Date(); d.setDate(d.getDate() + 2); return { iso: isoD(d), matched: (txt.match(/depois de amanh[ãa]/) || [])[0] }; }
  if (/\bamanh[ãa](?=\W|$)/.test(txt))           { const d = new Date(); d.setDate(d.getDate() + 1); return { iso: isoD(d), matched: (txt.match(/amanh[ãa]/) || [])[0] }; }
  if (/\bhoje\b/.test(txt))                { return { iso: isoD(new Date()), matched: 'hoje' }; }
  // dd/mm(/yyyy)
  if (m = txt.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)) {
    const dd = +m[1], mo = +m[2];
    const yy = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
    return { iso: isoD(new Date(yy, mo - 1, dd, 12)), matched: m[0] };
  }
  // "dia 20"
  if (m = txt.match(/\bdia\s+(\d{1,2})\b/)) {
    const dd = +m[1], now = new Date();
    let d = new Date(now.getFullYear(), now.getMonth(), dd, 12);
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(now.getFullYear(), now.getMonth() + 1, dd, 12);
    return { iso: isoD(d), matched: m[0] };
  }
  // dias da semana (0=dom..6=sab)
  const dias = ['domingo', 'segunda', 'ter[çc]a', 'quarta', 'quinta', 'sexta', 's[áa]bado'];
  const abbr = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(${dias[i]}(?:-feira)?|${abbr[i]})\\b`);
    const mm = txt.match(re);
    if (mm) {
      let d = proximoDiaSemana(i);
      if (/\b(que vem|que vem|pr[óo]xim[ao])\b/.test(txt) && isoD(d) === isoD(new Date())) d.setDate(d.getDate() + 7);
      return { iso: isoD(d), matched: mm[0] };
    }
  }
  return null;
}

function parseHoraPt(t) {
  const txt = t.toLowerCase();
  let m, hh = null, mm = 0, matched = null;
  if (/\bmeio[\s-]?dia\b/.test(txt))   return { hora: '12:00', matched: (txt.match(/meio[\s-]?dia/) || [])[0] };
  if (/\bmeia[\s-]?noite\b/.test(txt)) return { hora: '00:00', matched: (txt.match(/meia[\s-]?noite/) || [])[0] };
  if (m = txt.match(/\b(\d{1,2})[:h](\d{2})\b/))      { hh = +m[1]; mm = +m[2]; matched = m[0]; }
  else if (m = txt.match(/\b(\d{1,2})\s*h\b/))        { hh = +m[1]; matched = m[0]; }
  else if (m = txt.match(/\b(\d{1,2})\s*horas?\b/))   { hh = +m[1]; matched = m[0]; }
  else if (m = txt.match(/(?:^|\s)[àa]s\s+(\d{1,2})\b/)) { hh = +m[1]; matched = m[0].trim(); }
  if (hh == null) return null;
  if (/\bda\s+(tarde|noite)\b/.test(txt) && hh < 12) hh += 12;
  if (/\bda\s+manh[ãa](?=\W|$)/.test(txt) && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hora: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, matched };
}

// ─── Antecedência do lembrete em MINUTOS, a partir da fala ──────────────
// "me avisa 1 dia antes" · "avisa 30 min antes" · "lembra 2h antes" · "na hora".
// Cap em 2 dias (2880) — é a janela que o cron JOB 1J consegue antecipar.
function parseAntecedenciaPt(t) {
  const txt = t.toLowerCase();
  let m;
  if (/\b(na\s+hora|no\s+hor[áa]rio|em\s+cima\s+da\s+hora)\b/.test(txt))
    return { minutos: 0, matched: (txt.match(/(?:me\s+)?(?:avis\w+|lembr\w+)?\s*(?:na\s+hora|no\s+hor[áa]rio|em\s+cima\s+da\s+hora)/) || ['na hora'])[0] };
  if (/\bmeia\s+hora\s+antes\b/.test(txt))
    return { minutos: 30, matched: (txt.match(/(?:me\s+)?(?:avis\w+|lembr\w+)?\s*meia\s+hora\s+antes/) || ['meia hora antes'])[0] };
  if (m = txt.match(/(?:(?:me\s+)?(?:avis\w+|lembr\w+)\s+)?(\d{1,2})\s*dias?\s+antes/)) return { minutos: Math.min(+m[1] * 1440, 2880), matched: m[0] };
  if (/\bum\s+dia\s+antes\b/.test(txt)) return { minutos: 1440, matched: (txt.match(/(?:me\s+)?(?:avis\w+|lembr\w+)?\s*um\s+dia\s+antes/) || ['um dia antes'])[0] };
  if (m = txt.match(/(?:(?:me\s+)?(?:avis\w+|lembr\w+)\s+)?(\d{1,2})\s*(?:h|horas?)\s+antes/)) return { minutos: Math.min(+m[1] * 60, 2880), matched: m[0] };
  if (m = txt.match(/(?:(?:me\s+)?(?:avis\w+|lembr\w+)\s+)?(\d{1,3})\s*(?:min|minutos?|mins?)\s+antes/)) return { minutos: +m[1], matched: m[0] };
  return null;
}

// Texto humano da antecedência pra confirmação. minutos=null → default do sistema.
function fmtAntecedencia(minutos, temHora) {
  if (minutos == null)     return temHora ? 'Te aviso 1h antes' : 'Te aviso de manhã';
  if (minutos === 0)       return 'Te aviso na hora';
  if (minutos % 1440 === 0) { const d = minutos / 1440; return `Te aviso ${d} dia${d > 1 ? 's' : ''} antes`; }
  if (minutos % 60 === 0)   { const h = minutos / 60;  return `Te aviso ${h}h antes`; }
  return `Te aviso ${minutos} min antes`;
}

// Acesso às features Premium+ do Grow (Saúde, Estudos, Casa-avançada).
// Base (hábitos/tarefas/bem-estar/compras/agenda) é de todos os planos.
function temGrowPremium(user) {
  if (!user) return false;
  if (user.plano === 'premium' || user.plano === 'black') return true;
  if (user.plano_grow === 'grow_premium') return true;
  if (user.plano_grow === 'trial' && user.grow_trial_fim && new Date(user.grow_trial_fim) > new Date()) return true;
  return false;
}

// Comando direto de marcar ("marca/agenda/anota dentista terça 15h")
const RE_AGENDA_DIRETO = /^(?:marca[r]?|marque|agenda[r]?|agende|anota[r]?\s+(?:a[íi]\s+)?(?:que\s+)?|novo\s+compromisso|criar\s+compromisso|adiciona[r]?\s+compromisso)\s+/i;
// Verbos/substantivos de agenda que, JUNTO de uma data/hora, indicam compromisso.
const RE_AGENDA_NATURAL = /\b(me\s+)?lembr\w+\b|\b(anota[r]?|agenda[r]?|marca[r]?)\b|\b(reuni[ãa]o|consulta|compromisso|m[ée]dic[oa]|dentista|encontro|anivers[áa]rio|evento|call|entrevista|apresenta[çc][ãa]o|audi[êe]ncia|prova)\b/i;

// Detecta intenção de marcar compromisso — fast-path determinístico no webhook
// (sem depender do classificador de IA). Mesmo gatilho do handler.
function pareceCompromisso(mensagem) {
  const msg = (mensagem || '').toLowerCase().trim();
  if (RE_AGENDA_DIRETO.test(msg)) return true;
  if (RE_AGENDA_NATURAL.test(msg) && (parseDataPt(msg) || parseHoraPt(msg))) return true;
  return false;
}

// Mensagem que SÓ ajusta a antecedência do último compromisso ("me lembra 1 dia
// antes", "6 horas antes", "me avise 30 min antes"). Tem antecedência, NÃO tem
// data nova, e o que sobra é só "fluff" (me/pode/por favor/sora...).
function pareceAjusteLembrete(mensagem) {
  const msg = (mensagem || '').toLowerCase().trim();
  const ant = parseAntecedenciaPt(msg);
  if (!ant) return false;
  const base = msg.replace(ant.matched, ' ');
  if (parseDataPt(base)) return false; // tem data → é compromisso novo, não ajuste
  const fluff = base
    .replace(/^\s*sora[,!.\s]+/i, '')
    .replace(/\b(me|pode|poderia|consegue|por\s*favor|pf|ent[aã]o|a[íi]|ai|na\s+verdade|melhor|prefiro|quero|queria|sim|ok|isso|t[áa]|pra|para|o|de)\b/gi, ' ')
    .replace(/\b(me\s+)?(avis\w+|lembr\w+)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  return fluff.length === 0;
}

// Detector combinado pro fast-path do webhook (criar OU ajustar lembrete).
function pareceAgenda(mensagem) {
  return pareceCompromisso(mensagem) || pareceAjusteLembrete(mensagem);
}

module.exports = async function handleGrow(mensagem, ctx, opts = {}) {
  const { phone, grupoId, user } = ctx;
  // Tira o vocativo "Sora," do começo — senão quebra as âncoras ^ de vários
  // padrões (ex.: "Sora, comi 2 ovos" não casava o registro de refeição).
  mensagem = (mensagem || '').replace(/^\s*sora[,!.:\s]+/i, '');
  const msg = mensagem.toLowerCase().trim();
  const growPremium = temGrowPremium(user);

  // Privacidade do Grow: Hábitos/Tarefas/Agenda são sempre por user.id.
  // Casa (despensa/receitas/manutenções/compras) lê por grupo_id só quando
  // a flag do grupo está ligada — senão por user.id. Coleções não passam aqui.
  const cfg = await growShareCfg(grupoId);
  const escCasa = (q) => cfg.casa ? q.eq('grupo_id', grupoId) : q.eq('user_id', user.id);

  // Saúde e Estudos são Premium+ — só roteia pra esses handlers se o plano dá
  // acesso (medicamentos, peso, água, treino, consultas / estudei, provas, notas).
  if (growPremium) {
    const tratouSaude = await handleSaude(mensagem, ctx);
    if (tratouSaude) return;
    const tratouEstudos = await handleEstudos(mensagem, ctx);
    if (tratouEstudos) return;
  }

  // ── LISTAR (hábitos / tarefas / compras) ────────────────────────────
  if (/^(meus\s+habitos|habitos|meus\s+hábitos|hábitos)$/i.test(msg)) {
    const { data: habitos } = await supabase.from('habitos')
      .select('id, nome, icone').eq('user_id', user.id).eq('ativo', true);
    if (!habitos?.length) {
      await enviarTexto(phone, '🌱 Voce ainda nao tem habitos cadastrados. Crie no painel Grow ou diga: *novo habito beber agua*');
      return;
    }
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: regs } = await supabase.from('registros_habito')
      .select('habito_id, concluido').eq('user_id', user.id).eq('data', hoje);
    const concluidos = new Set((regs || []).filter(r => r.concluido).map(r => r.habito_id));
    const linhas = habitos.map(h => `${concluidos.has(h.id) ? '✅' : '⬜'} ${h.icone} ${h.nome}`);
    await enviarTexto(phone, `🌱 *Seus habitos de hoje*\n\n${linhas.join('\n')}\n\nPara marcar: *fiz [nome do habito]*`);
    return;
  }

  if (/^(minhas\s+tarefas|tarefas|todo|todos)$/i.test(msg)) {
    const { data: tarefas } = await supabase.from('tarefas')
      .select('titulo, prioridade').eq('user_id', user.id).eq('concluida', false)
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
    let qItens = supabase.from('itens_lista_compras')
      .select('nome, quantidade, comprado').eq('lista_id', lista.id);
    if (!cfg.casa) qItens = qItens.eq('user_id', user.id);
    const { data: itens } = await qItens
      .order('comprado').order('created_at', { ascending: false });
    if (!itens?.length) { await enviarTexto(phone, '🛒 Lista vazia. Adicione: *comprar leite*'); return; }
    const linhas = itens.map(i => `${i.comprado ? '✅' : '⬜'} ${i.nome}${i.quantidade && i.quantidade !== '1' ? ` (${i.quantidade})` : ''}`);
    const pendentes = itens.filter(i => !i.comprado).length;
    await enviarTexto(phone, `🛒 *Lista de compras* (${pendentes} pendente${pendentes === 1 ? '' : 's'})\n\n${linhas.join('\n')}`);
    return;
  }

  let m;

  // ── Casa-avançada (Despensa / Receitas / Manutenções) = Premium+ ────
  // Intercepta antes dos blocos abaixo e oferece upgrade pra quem é Básico.
  if (!growPremium && (
        /\b(manuten[çc]|despensa|receita|cozinh|ingrediente)/i.test(msg)
        || /^(acabou|acabando|t[aá]\s+acabando|est[aá]\s+acabando)\b/i.test(msg)
        || /o\s+que\s+.*(cozinhar|falta\s+em\s+casa)/i.test(msg))) {
    await enviarTexto(phone,
      '🔒 *Despensa, Receitas e Manutenções da casa* fazem parte do plano *Premium*.\n\n' +
      'No seu plano você já tem hábitos, tarefas, bem-estar, lista de compras e agenda. ✨\n\n' +
      'Ver planos: 🌐 forsora.com/planos');
    return;
  }

  // ── MANUTENÇÕES: listar ─────────────────────────────────────────────
  if (/^(minhas\s+manuten[çc][õo]es|manuten[çc][õo]es|manuten[çc][aã]o)$/i.test(msg)) {
    const { data: mans } = await escCasa(supabase.from('manutencoes')
      .select('nome, icone, frequencia_dias, ultima_data'));
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
    const { data: achados } = await escCasa(supabase.from('manutencoes')
      .select('id, nome, icone, frequencia_dias')).ilike('nome', `%${termo}%`);
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
      grupo_id: grupoId, user_id: user.id, nome, icone: '🎯', cor: '#7c3aed',
    }).select().single();
    await enviarTexto(phone, `🌱 *Habito criado!*\n\n🎯 ${h.nome}\n\nPara marcar como feito hoje: *fiz ${nome}*`);
    return;
  }

  // ── MARCAR TODOS OS HABITOS DE HOJE ─────────────────────────────────
  // Vem ANTES do "fiz [nome]" pra "fiz todos" não cair na busca por nome.
  if (/^(?:fiz|completei|conclu[ií]|terminei|marquei|fechei)\s+(?:todos?|tudo)(?:\s+(?:os\s+)?h[aá]bitos?)?(?:\s+(?:de\s+)?hoje)?$/i.test(msg)) {
    const diaSemana = (() => { const j = new Date().getDay(); return j === 0 ? 7 : j; })();
    const { data: habitos } = await supabase.from('habitos')
      .select('id, nome, icone, dias_semana').eq('user_id', user.id).eq('ativo', true);
    const doDia = (habitos || []).filter(h => (h.dias_semana || [1,2,3,4,5,6,7]).includes(diaSemana));
    if (!doDia.length) {
      await enviarTexto(phone, '🌱 Voce nao tem habitos pra hoje. Crie no painel ou diga: *novo habito beber agua*');
      return;
    }
    const hoje = new Date().toISOString().slice(0, 10);
    await supabase.from('registros_habito').upsert(
      doDia.map(h => ({ habito_id: h.id, grupo_id: grupoId, user_id: user.id, data: hoje, concluido: true })),
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
      .select('id, nome, icone').eq('user_id', user.id).eq('ativo', true)
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
      { habito_id: habito.id, grupo_id: grupoId, user_id: user.id, data: hoje, concluido: true },
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
      grupo_id: grupoId, user_id: user.id, titulo, prioridade, criado_por: user.id,
    }).select().single();
    const priLabel = { urgente: ' 🔴 URGENTE', alta: ' 🟠 Alta prioridade', media: '', baixa: ' 🟢' };
    await enviarTexto(phone, `📋 *Tarefa criada*${priLabel[prioridade]}\n\n${t.titulo}\n\nVer todas: *tarefas*`);
    return;
  }

  // ── DESPENSA: listar status ─────────────────────────────────────────
  if (/^(minha\s+despensa|despensa|o\s+que\s+(t[aá]|est[aá])\s+acabando|que\s+falta\s+em\s+casa)$/i.test(msg)) {
    const { data: itens } = await escCasa(supabase.from('despensa_itens')
      .select('nome, status'));
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
    let { data: achados } = await escCasa(supabase.from('despensa_itens')
      .select('id, nome')).ilike('nome', `%${termo}%`);
    let item;
    if (achados?.length) {
      item = achados[0];
      await supabase.from('despensa_itens')
        .update({ status: novoStatus, updated_at: new Date().toISOString() }).eq('id', item.id);
    } else {
      const { data: novo } = await supabase.from('despensa_itens')
        .insert({ grupo_id: grupoId, user_id: user.id, nome: termo, status: novoStatus }).select().single();
      item = novo;
    }
    // Garante na lista de compras (linkado, sem duplicar)
    const listaId = await getOrCreateLista(grupoId);
    const { data: jaTem } = await supabase.from('itens_lista_compras')
      .select('id').eq('lista_id', listaId).eq('despensa_item_id', item.id).eq('comprado', false).maybeSingle();
    if (!jaTem) {
      await supabase.from('itens_lista_compras')
        .insert({ lista_id: listaId, nome: item.nome, user_id: user.id, despensa_item_id: item.id });
    }
    await enviarTexto(phone, `🛒 *${item.nome}* ${novoStatus === 'acabando' ? 'tá acabando' : 'acabou'} — já coloquei na lista de compras!\n\nVer lista: *lista de compras*`);
    return;
  }

  // ── RECEITAS: o que dá pra cozinhar com o que tem em casa ───────────
  if (/^(?:o\s+que\s+(?:eu\s+)?(?:posso|d[aá]\s+(?:pra?|para))\s+cozinhar|o\s+que\s+(?:eu\s+)?fa[çc]o\s+(?:pra?|para)\s+(?:comer|jantar|almo[çc]ar)|sugest[ãa]o\s+de\s+receita)/i.test(msg)) {
    const { data: receitas } = await escCasa(supabase.from('receitas')
      .select('id, nome, icone'));
    if (!receitas?.length) {
      await enviarTexto(phone, '🍳 Você ainda não cadastrou receitas. Crie no painel: *Casa → Receitas*.');
      return;
    }
    const { data: ings } = await supabase.from('receita_ingredientes')
      .select('receita_id, nome').in('receita_id', receitas.map(r => r.id));
    const { data: despensa } = await escCasa(supabase.from('despensa_itens')
      .select('nome, status'));
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
    const { data: receitas } = await escCasa(supabase.from('receitas')
      .select('id, nome, icone, tempo_min, porcoes'))
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
    const { data: achadas } = await escCasa(supabase.from('receitas')
      .select('id, nome, icone')).ilike('nome', `%${termo}%`);
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
    const { data: despensa } = await escCasa(supabase.from('despensa_itens')
      .select('id, nome, status'));
    const acha = nome => (despensa || []).find(d => {
      const a = d.nome.toLowerCase(), b = nome.toLowerCase();
      return a.includes(b) || b.includes(a);
    });
    const listaId = await getOrCreateLista(grupoId);
    const adicionados = [], jaTem = [];
    for (const ing of ings) {
      const match = acha(ing.nome);
      if (match && match.status === 'tem') { jaTem.push(ing.nome); continue; }
      let qDup = supabase.from('itens_lista_compras')
        .select('id').eq('lista_id', listaId).ilike('nome', ing.nome).eq('comprado', false);
      if (!cfg.casa) qDup = qDup.eq('user_id', user.id);
      const { data: dup } = await qDup.maybeSingle();
      if (!dup) {
        await supabase.from('itens_lista_compras').insert({
          lista_id: listaId, nome: ing.nome, quantidade: ing.quantidade || '1', user_id: user.id,
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
    const { data: achadas } = await escCasa(supabase.from('receitas')
      .select('id, nome, icone, tempo_min, porcoes, modo_preparo')).ilike('nome', `%${termo}%`);
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

  // ── AGENDA: hoje / próximos dias ────────────────────────────────────
  if (/^(minha\s+agenda|agenda(\s+(hoje|semana|da\s+semana|esta\s+semana))?|meus\s+compromissos|compromissos)$/i.test(msg)) {
    const soHoje = /hoje/i.test(msg);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const ate = new Date(hoje); ate.setDate(ate.getDate() + (soHoje ? 0 : 7));
    const deStr = hoje.toISOString().slice(0, 10);
    const ateStr = ate.toISOString().slice(0, 10);
    const { data: comps } = await supabase.from('compromissos')
      .select('titulo, data, hora, local').eq('user_id', user.id)
      .gte('data', deStr).lte('data', ateStr)
      .order('data', { ascending: true }).order('hora', { ascending: true, nullsFirst: true });
    if (!comps?.length) {
      await enviarTexto(phone, soHoje
        ? '📅 Você não tem compromissos hoje. Aproveita! 😎'
        : '📅 Nenhum compromisso nos próximos 7 dias. Pra adicionar, use o painel: *Grow → Agenda*.');
      return;
    }
    const fmtDia = (s) => {
      const d = new Date(s + 'T12:00:00');
      const diff = Math.round((d - hoje) / 86400000);
      if (diff === 0) return 'Hoje';
      if (diff === 1) return 'Amanhã';
      return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }).replace('.', '');
    };
    const grupos = {};
    for (const c of comps) (grupos[c.data] = grupos[c.data] || []).push(c);
    const blocos = Object.entries(grupos).map(([dia, lista]) => {
      const linhas = lista.map(c => `🕐 ${c.hora || 'dia todo'} — ${c.titulo}${c.local ? ` 📍 ${c.local}` : ''}`);
      return `*${fmtDia(dia)}*\n${linhas.join('\n')}`;
    });
    const titulo = soHoje ? '📅 *Sua agenda de hoje*' : '📅 *Próximos compromissos*';
    await enviarTexto(phone, `${titulo}\n\n${blocos.join('\n\n')}\n\nGerenciar: 🌐 forsora.com/grow/agenda`);
    return;
  }

  // ── AJUSTE do lembrete do último compromisso ────────────────────────
  // "me lembra 1 dia antes" · "6 horas antes" · "me avise 30 min antes".
  // Vem ANTES de criar — senão "6 horas antes" viraria evento às 06:00.
  if (pareceAjusteLembrete(msg)) {
    const ant = parseAntecedenciaPt(msg);
    const hojeStr = isoD(new Date());
    const { data: ultimo } = await supabase.from('compromissos')
      .select('id, titulo, hora')
      .eq('user_id', user.id).gte('data', hojeStr)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!ultimo) {
      await enviarTexto(phone, '🤔 Não achei um compromisso futuro pra ajustar o lembrete. Marca um primeiro, ex.: *marca dentista terça 15h*.');
      return;
    }
    await supabase.from('compromissos')
      .update({ lembrete_antecedencia: ant.minutos, lembrete_ativo: true, lembrete_enviado: false })
      .eq('id', ultimo.id);
    await enviarTexto(phone, `🔔 Feito! Pro *${ultimo.titulo}*, ${fmtAntecedencia(ant.minutos, !!ultimo.hora).toLowerCase()}.`);
    return;
  }

  // ── AGENDA: criar compromisso por linguagem natural ─────────────────
  // "marca dentista terça 15h" · "agendar reunião amanhã 9h" · "marcar aniversário dia 20"
  // Aceita 2 formas:
  //   1. Direto: "marca dentista terça 15h" · "agendar reunião amanhã 9h"
  //   2. Natural: "tenho uma reunião amanhã às 19, me lembra?" — pedido de
  //      lembrete (lembr…) JUNTO de uma data/hora. Local-first: sem IA.
  let restoAg = null;
  if ((m = msg.match(RE_AGENDA_DIRETO))) {
    restoAg = msg.slice(m[0].length).trim();   // tira o verbo do começo ("marca/anota que ...")
  } else if (RE_AGENDA_NATURAL.test(msg) && (parseDataPt(msg) || parseHoraPt(msg))) {
    restoAg = msg
      .replace(/^\s*sora[,!.\s]+/i, '')                              // "Sora, ..."
      .replace(/^\s*(anota[r]?|agenda[r]?|marca[r]?)(\s+a[íi])?\s+(que\s+)?/i, '') // "anota aí que ..."
      .replace(/\b(que\s+eu\s+)?tenho\b|\btem\b|\bvou\s+ter\b/gi, ' ') // "tenho/tem/vou ter"
      .replace(/\bque\s+vem\b/gi, ' ')                              // "terça que vem" → "terça"
      .replace(/\b(me\s+)?lembr\w+\b/gi, ' ')                       // "me lembra"
      .replace(/\b(uma|um)\b/gi, ' ')
      .replace(/\bque\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (restoAg) {
    const resto = restoAg;
    // Antecedência do lembrete sai do texto ANTES da hora — senão "avisa 2h
    // antes" seria confundido com o horário do evento.
    const ant = parseAntecedenciaPt(resto);
    const base = ant?.matched ? resto.replace(ant.matched, ' ') : resto;
    const dt = parseDataPt(base);
    const hr = parseHoraPt(dt?.matched ? base.replace(dt.matched, ' ') : base);
    if (!dt && !hr) {
      await enviarTexto(phone, '📅 Pra marcar, me diz *o quê* e *quando*.\n\nEx.: *marca dentista terça 15h* · *agendar reunião amanhã 9h me avisa 1 dia antes*');
      return;
    }
    const dataISO = dt ? dt.iso : isoD(new Date());
    let titulo = base;
    if (dt?.matched) titulo = titulo.replace(dt.matched, ' ');
    if (hr?.matched) titulo = titulo.replace(hr.matched, ' ');
    titulo = titulo.replace(/\bda\s+(manh[ãa]|tarde|noite)\b/gi, ' ');
    titulo = titulo.replace(/\b(me\s+)?(avis\w+|lembr\w+)\b/gi, ' ');
    titulo = titulo.replace(/[,;.!?]+/g, ' ').replace(/\s+/g, ' ').trim();
    titulo = titulo.replace(/^(de|do|da|no|na|para|pra|pro|[àa]s|o|a|um|uma|e)\s+/i, '').replace(/\s+(de|do|da|no|na|para|pra|pro|e|[àa]s)$/i, '').trim();
    if (!titulo) titulo = 'Compromisso';
    titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);
    const hora = hr ? hr.hora : null;
    const antecedencia = ant ? ant.minutos : (hora ? 60 : 0);
    const { error } = await supabase.from('compromissos').insert({
      grupo_id: grupoId, user_id: user.id, titulo, data: dataISO, hora,
      categoria: 'pessoal', cor: '#7c3aed',
      lembrete_ativo: true, lembrete_antecedencia: antecedencia,
    });
    if (error) {
      await enviarTexto(phone, '😕 Não consegui salvar agora. Tenta pelo painel: forsora.com/grow/agenda');
      return;
    }
    const dataFmt = new Date(dataISO + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    await enviarTexto(phone,
      `📅 *Marquei!*\n\n*${titulo}*\n🗓️ ${dataFmt}${hora ? ` às ${hora}` : ' (dia todo)'}\n` +
      `🔔 ${fmtAntecedencia(ant ? ant.minutos : null, !!hora)}\n\n` +
      `_Quer ser avisado em outro momento? É só me dizer aqui, ex.: *me lembra 1 dia antes* ou *2 horas antes*._\n\n` +
      `Ver agenda: 🌐 forsora.com/grow/agenda`);
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
  // "comprar X" no começo OU em frase de intenção ("tô precisando comprar X").
  if ((m = msg.match(/^(?:comprar|adicionar\s+na\s+lista|lista)\s+(.+)$/i))
    || (m = msg.match(/\bcomprar\s+(.+)$/i))) {
    // Vários itens numa frase: "pão, leite e café" → 3 itens.
    const itens = m[1].trim().replace(/^(mais|uns|umas|um|uma)\s+/i, '')
      .split(/\s*,\s*|\s+e\s+/i).map(s => s.trim()).filter(Boolean);
    if (!itens.length) { await enviarTexto(phone, '🛒 O que você quer comprar? Ex.: *comprar leite e pão*'); return; }
    const { data: existing } = await supabase.from('listas_compras')
      .select('id').eq('grupo_id', grupoId).eq('ativa', true).maybeSingle();
    let listaId = existing?.id;
    if (!listaId) {
      const { data: nova } = await supabase.from('listas_compras')
        .insert({ grupo_id: grupoId }).select('id').single();
      listaId = nova.id;
    }
    await supabase.from('itens_lista_compras').insert(itens.map(nome => ({ lista_id: listaId, nome })));
    const txtItens = itens.length > 1 ? `Adicionei à lista: *${itens.join(', ')}*` : `*"${itens[0]}"* adicionado à lista!`;
    await enviarTexto(phone, `🛒 ${txtItens}\n\nVer tudo: *lista de compras*`);
    return;
  }

  // ── FALLBACK ────────────────────────────────────────────────────────
  // Antes de desistir: a IA traduz a frase natural num comando canônico (só
  // quando o parser local não reconheceu nada) e reexecuta UMA vez sem IA.
  // Local-first preservado — a IA só roda nesse caso raro.
  if (!opts.semIA) {
    try {
      const { interpretarGrowComando } = require('../services/ia');
      const cmd = await interpretarGrowComando(mensagem);
      if (cmd && cmd.toLowerCase().trim() !== msg) {
        console.log(`🌱→IA traduziu: "${mensagem}" → "${cmd}"`);
        return await handleGrow(cmd, ctx, { semIA: true });
      }
    } catch { /* cai no menu padrão */ }
  }

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

// Detectores expostos pro webhook usar como fast-path (sem IA).
module.exports.pareceCompromisso = pareceCompromisso;
module.exports.pareceAgenda = pareceAgenda; // criar OU ajustar lembrete
