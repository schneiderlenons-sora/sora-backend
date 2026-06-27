// ─────────────────────────────────────────────────────────────────
// Sora · Estudos — comandos WhatsApp
// Chamado de dentro do handlers/grow.js, retorna true se reconheceu.
// ─────────────────────────────────────────────────────────────────
const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function buscarDisciplina(userId, termo) {
  const t = (termo || '').trim();
  if (!t) return [];
  const { data } = await supabase.from('disciplinas').select('*')
    .eq('user_id', userId).ilike('nome', `%${t}%`).limit(5);
  return data || [];
}

function parseDuracao(texto) {
  // "60 min" / "1h" / "1h30" / "90min"
  let m;
  if ((m = texto.match(/(\d+)\s*h(?:oras?)?\s*(?:(\d+)\s*min?)?/i))) {
    return parseInt(m[1]) * 60 + (m[2] ? parseInt(m[2]) : 0);
  }
  if ((m = texto.match(/(\d+)\s*min(?:utos)?/i))) {
    return parseInt(m[1]);
  }
  if ((m = texto.match(/^(\d+)$/))) {
    return parseInt(m[1]);
  }
  return null;
}

async function calcStreak(userId) {
  const { data } = await supabase.from('sessoes_estudo').select('data').eq('user_id', userId).order('data', { ascending: false }).limit(400);
  if (!data?.length) return 0;
  const datas = new Set(data.map(s => s.data));
  let streak = 0;
  const cur = new Date(); cur.setHours(0,0,0,0);
  for (let i = 0; i < 365; i++) {
    const d = new Date(cur); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if (datas.has(iso)) streak++;
    else if (i === 0) continue;
    else break;
  }
  return streak;
}

module.exports = async function handleEstudos(mensagem, ctx) {
  const { phone, grupoId, user } = ctx;
  const msg = norm(mensagem);
  let m;

  // ── REGISTRAR SESSÃO DE ESTUDO ────────────────────────────────────
  // "estudei matematica 60 min" / "estudei direito 1h" / "estudei portugues 1h30"
  if ((m = msg.match(/^estudei\s+(.+?)\s+(\d+\s*(?:h|min|hora|horas|minutos)?(?:\s*\d+\s*min)?)\s*$/i))) {
    const termo = m[1].trim();
    const duracao = parseDuracao(m[2]);
    if (!duracao || duracao <= 0) {
      await enviarTexto(phone, '❌ Duração inválida. Ex: *estudei matemática 60 min* ou *estudei direito 1h30*');
      return true;
    }

    const matches = await buscarDisciplina(user.id, termo);
    let disciplinaId = null;
    let nomeDisciplina = termo;
    if (matches.length === 1) {
      disciplinaId = matches[0].id;
      nomeDisciplina = matches[0].nome;
    } else if (matches.length === 0) {
      // Cria disciplina nova
      const { data: nova } = await supabase.from('disciplinas').insert({
        grupo_id: grupoId, user_id: user.id, nome: termo, prioridade: 3,
      }).select().single();
      disciplinaId = nova?.id;
      nomeDisciplina = termo;
    } else {
      const lista = matches.map(d => `• ${d.icone || '📚'} ${d.nome}`).join('\n');
      await enviarTexto(phone, `🤔 Mais de uma disciplina com *"${termo}"*:\n${lista}\n\nSeja mais específico.`);
      return true;
    }

    await supabase.from('sessoes_estudo').insert({
      grupo_id: grupoId, user_id: user.id, disciplina_id: disciplinaId,
      data: new Date().toISOString().slice(0, 10),
      duracao_min: duracao, tipo: 'estudo',
    });

    const streak = await calcStreak(user.id);
    const horas = duracao >= 60 ? `${Math.floor(duracao/60)}h${duracao%60 ? duracao%60 + 'min' : ''}` : `${duracao}min`;
    const cauda = streak >= 30 ? ` 🏆 *${streak} dias seguidos!*`
              : streak >= 14 ? ` 🔥 *${streak} dias seguidos!* Imparável!`
              : streak >= 7  ? ` 🔥 *${streak} dias seguidos!*`
              : streak > 1   ? ` Sequência: ${streak} dias.`
              : '';
    await enviarTexto(phone, `📚 Sessão registrada: *${nomeDisciplina}* — ${horas}.${cauda}`);
    return true;
  }

  // ── LISTAR PROVAS ─────────────────────────────────────────────────
  if (/^(minhas\s+provas|proximas\s+provas|próximas\s+provas|provas)$/i.test(msg)) {
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: provas } = await supabase.from('provas')
      .select('*, disciplinas(nome, icone)')
      .eq('user_id', user.id).eq('realizada', false).gte('data', hoje)
      .order('data').limit(10);
    if (!provas?.length) { await enviarTexto(phone, '✨ Nenhuma prova agendada.'); return true; }
    const linhas = provas.map(p => {
      const d = new Date(p.data + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
      const dias = Math.ceil((new Date(p.data) - new Date(hoje)) / 86400000);
      const urgencia = dias === 0 ? '🚨 HOJE' : dias === 1 ? '⏰ AMANHÃ' : `em ${dias}d`;
      return `📝 *${p.titulo}* — ${d} (${urgencia})${p.disciplinas?.nome ? ` · ${p.disciplinas.nome}` : ''}`;
    });
    await enviarTexto(phone, `📅 *Próximas provas* (${provas.length})\n\n${linhas.join('\n')}`);
    return true;
  }

  // ── LISTAR DISCIPLINAS / STREAK ──────────────────────────────────
  if (/^(minhas\s+disciplinas|materias|matérias|disciplinas|meu\s+streak|streak\s+estudos?)$/i.test(msg)) {
    const streak = await calcStreak(user.id);
    const { data: discs } = await supabase.from('disciplinas')
      .select('*').eq('user_id', user.id).eq('status', 'ativa').order('prioridade', { ascending: false });

    const inicioSemana = new Date(); inicioSemana.setDate(inicioSemana.getDate() - 6);
    const { data: sessoes } = await supabase.from('sessoes_estudo')
      .select('disciplina_id, duracao_min').eq('user_id', user.id)
      .gte('data', inicioSemana.toISOString().slice(0, 10));

    const minPorDisc = {};
    (sessoes || []).forEach(s => {
      minPorDisc[s.disciplina_id] = (minPorDisc[s.disciplina_id] || 0) + (s.duracao_min || 0);
    });
    const totalSemana = Object.values(minPorDisc).reduce((a, b) => a + b, 0);

    const linhas = (discs || []).slice(0, 10).map(d => {
      const min = minPorDisc[d.id] || 0;
      const h = Math.floor(min/60), mm = min%60;
      return `${d.icone || '📚'} *${d.nome}* — ${h ? h+'h' : ''}${mm ? mm+'min' : (h ? '' : '0min')}`;
    });

    await enviarTexto(phone,
      `📚 *Estudos — última semana*\n\n` +
      `🔥 Streak: *${streak}* dia${streak === 1 ? '' : 's'} seguido${streak === 1 ? '' : 's'}\n` +
      `⏱️ Total: *${Math.floor(totalSemana/60)}h${totalSemana%60 ? (totalSemana%60)+'min' : ''}*\n\n` +
      (linhas.length ? linhas.join('\n') : 'Nenhuma disciplina cadastrada.')
    );
    return true;
  }

  // ── REGISTRAR NOTA DE PROVA ──────────────────────────────────────
  // "tirei 8 na prova de X" / "tirei 7.5 em historia"
  if ((m = msg.match(/^tirei\s+(\d+(?:[.,]\d+)?)\s+(?:na\s+prova\s+de\s+|em\s+)(.+)$/i))) {
    const nota = parseFloat(m[1].replace(',', '.'));
    const termo = m[2].trim();
    // Busca prova relacionada à disciplina
    const matches = await buscarDisciplina(user.id, termo);
    if (matches.length === 0) {
      await enviarTexto(phone, `❌ Não encontrei disciplina com *"${termo}"*.`);
      return true;
    }
    const discId = matches[0].id;
    // Pega a prova mais próxima dessa disciplina ainda não realizada
    const { data: provas } = await supabase.from('provas').select('*')
      .eq('user_id', user.id).eq('disciplina_id', discId).eq('realizada', false)
      .order('data').limit(1);
    if (!provas?.length) {
      await enviarTexto(phone, `❌ Nenhuma prova pendente cadastrada para *${matches[0].nome}*.`);
      return true;
    }
    await supabase.from('provas').update({
      nota_obtida: nota, realizada: true,
    }).eq('id', provas[0].id);
    const max = provas[0].nota_maxima || 10;
    const pct = ((nota / max) * 100).toFixed(0);
    await enviarTexto(phone, `✅ Nota *${nota}/${max}* (${pct}%) registrada em *${provas[0].titulo}*.`);
    return true;
  }

  return false;
};
