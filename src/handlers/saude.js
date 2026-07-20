// ─────────────────────────────────────────────────────────────────
// Sora · Saúde — handler de comandos WhatsApp pra:
// medicamentos (tomei X), peso, água, treino, consultas, exames.
// Chamado de dentro do handlers/grow.js, retorna true se tratou.
// ─────────────────────────────────────────────────────────────────
const supabase = require('../db/supabase');
const { enviarTexto, enviarBotaoLink } = require('../services/mensageiro');
const nutricao = require('../services/nutricao');

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function buscarMed(grupoId, termo) {
  const t = (termo || '').trim();
  if (!t) return [];
  const { data } = await supabase.from('medicamentos')
    .select('*').eq('grupo_id', grupoId).eq('ativo', true)
    .ilike('nome', `%${t}%`);
  return data || [];
}

// Horário (HH:MM) do medicamento mais perto de agora (fuso SP). Usado quando o
// usuário dá baixa por texto ("tomei X") sem dizer o horário.
function horarioMaisProximo(horarios) {
  if (!horarios || !horarios.length) return null;
  const spNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const nowMin = spNow.getHours() * 60 + spNow.getMinutes();
  let best = null, bestDiff = Infinity;
  for (const h of horarios) {
    const [hh, mm] = String(h).slice(0, 5).split(':').map(Number);
    const diff = Math.abs(hh * 60 + mm - nowMin);
    if (diff < bestDiff) { bestDiff = diff; best = String(h).slice(0, 5); }
  }
  return best;
}

module.exports = async function handleSaude(mensagem, ctx) {
  const { phone, grupoId, user } = ctx;
  const msg = norm(mensagem);
  let m;

  // ── TOMEI MEDICAMENTO ────────────────────────────────────────────
  // "tomei losartana" / "tomei 50mg de losartana"
  if ((m = msg.match(/^tomei\s+(?:\d+\s*mg\s+(?:de\s+)?)?(.+)$/i))) {
    const termo = m[1].trim();
    const meds = await buscarMed(grupoId, termo);
    if (meds.length === 0) {
      // Não é medicamento — deixa o grow handler tentar outras coisas
      return false;
    }
    if (meds.length > 1) {
      const lista = meds.map(x => `• ${x.nome} ${x.dosagem || ''}`.trim()).join('\n');
      await enviarTexto(phone, `🤔 Tenho mais de um medicamento com *"${termo}"*:\n${lista}\n\nSeja mais específico.`);
      return true;
    }
    const med = meds[0];
    const agora = new Date();
    // Casa com o horário mais próximo de agora (SP) pra o painel marcar o slot
    // certo — não todos. Coluna nova (082): grava sem ela se ainda não migrou.
    const horario = horarioMaisProximo(med.horarios);
    const baseDose = {
      medicamento_id: med.id, user_id: user.id,
      datetime_tomado: agora.toISOString(), status: 'tomou',
    };
    let insDose = await supabase.from('medicamento_doses').insert({ ...baseDose, horario });
    if (insDose.error && horario && /horario|column/i.test(insDose.error.message || '')) {
      await supabase.from('medicamento_doses').insert(baseDose);
    }
    if (med.estoque_atual != null && med.estoque_atual > 0) {
      const novo = med.estoque_atual - 1;
      await supabase.from('medicamentos').update({ estoque_atual: novo }).eq('id', med.id);
      const baixo = novo <= (med.estoque_alerta || 5);
      await enviarTexto(phone,
        `✅ *${med.nome}* ${med.dosagem || ''} registrado.\n` +
        `📦 Estoque: ${novo} comprimido${novo === 1 ? '' : 's'}` +
        (baixo ? `\n⚠️ Estoque baixo — hora de comprar.` : ''));
    } else {
      await enviarTexto(phone, `✅ *${med.nome}* ${med.dosagem || ''} registrado.`);
    }
    return true;
  }

  // ── REGISTRAR REFEIÇÃO (nutrição / macros) ───────────────────────
  // "comi 2 ovos e 1 pão", "almocei arroz feijão e frango" — texto OU áudio.
  // A IA (analisarRefeicao) separa os alimentos mesmo sem vírgula/pontuação.
  {
    const mealMatch = (mensagem || '').match(/^\s*(comi|almocei|jantei|lanchei|caf[eé]\s+da\s+manh[ãa])\s+(.+)$/i);
    if (mealMatch) {
      const verbo = norm(mealMatch[1]);
      const texto = mealMatch[2].trim().replace(/[.!]+$/, '').trim();
      const tipo = /almoc/.test(verbo) ? 'almoco' : /jant/.test(verbo) ? 'janta' : /caf/.test(verbo) ? 'cafe' : 'lanche';

      let itens = [];
      try {
        itens = await nutricao.analisarRefeicao(texto);
      } catch (e) {
        await enviarTexto(phone, '😕 Não consegui calcular os macros agora. Tenta de novo em instantes, ou registra pelo painel: 🌐 forsora.com/grow/saude');
        return true;
      }
      if (!itens.length) {
        await enviarTexto(phone, `🤔 Não identifiquei alimentos em *"${texto}"*.\nDescreve melhor, ex.: *comi 2 ovos e 1 fatia de pão*.`);
        return true;
      }

      const hoje = new Date().toISOString().slice(0, 10);
      const { data: ref } = await supabase.from('refeicoes').insert({
        grupo_id: grupoId, user_id: user.id, tipo, data: hoje, observacao: texto.slice(0, 200),
      }).select().single();
      if (ref) {
        await supabase.from('refeicao_itens').insert(itens.map(i => ({ ...i, refeicao_id: ref.id })));
      }

      const tot = itens.reduce((a, i) => ({
        cal: a.cal + (i.calorias || 0), p: a.p + (i.proteinas_g || 0),
        c: a.c + (i.carboidratos_g || 0), g: a.g + (i.gorduras_g || 0),
      }), { cal: 0, p: 0, c: 0, g: 0 });

      // Acumulado do dia + meta nutricional (se houver)
      const { data: refsHoje } = await supabase.from('refeicoes')
        .select('id').eq('user_id', user.id).eq('data', hoje);
      const ids = (refsHoje || []).map(r => r.id);
      let diaCal = 0, diaP = 0;
      if (ids.length) {
        const { data: its } = await supabase.from('refeicao_itens')
          .select('calorias, proteinas_g').in('refeicao_id', ids);
        for (const i of its || []) { diaCal += parseFloat(i.calorias) || 0; diaP += parseFloat(i.proteinas_g) || 0; }
      }
      let meta = null;
      try {
        const { data } = await supabase.from('metas_nutricao')
          .select('calorias, proteinas_g').eq('user_id', user.id).maybeSingle();
        meta = data;
      } catch {}

      const linhas = itens.map(i => `• ${i.nome}${i.porcao_descr ? ` (${i.porcao_descr})` : ''} — ${Math.round(i.calorias)} kcal`);
      let txt = `🍽️ *Refeição registrada!*\n\n${linhas.join('\n')}\n\n` +
        `📊 *Total:* ${Math.round(tot.cal)} kcal · P ${Math.round(tot.p)}g · C ${Math.round(tot.c)}g · G ${Math.round(tot.g)}g`;
      if (meta?.calorias) {
        const pct = Math.round((diaCal / meta.calorias) * 100);
        txt += `\n\n🎯 Hoje: *${Math.round(diaCal)} / ${meta.calorias} kcal* (${pct}%)`;
        if (meta.proteinas_g) txt += `\n💪 Proteína: ${Math.round(diaP)} / ${meta.proteinas_g}g`;
        if (diaCal > meta.calorias * 1.05) txt += `\n⚠️ Você passou da meta de calorias hoje.`;
      } else {
        txt += `\n\n📅 Total de hoje: *${Math.round(diaCal)} kcal*`;
      }
      await enviarBotaoLink(phone, {
        message: txt,
        label: 'Ver detalhes',
        url: 'https://forsora.com/grow/saude',
      });
      return true;
    }
  }

  // ── PESO ─────────────────────────────────────────────────────────
  if ((m = msg.match(/^(?:peso|registrar peso|to com|estou com)\s+(\d+(?:[.,]\d+)?)\s*kg?$/i))) {
    const v = parseFloat(m[1].replace(',', '.'));
    if (!v || v <= 0 || v > 600) {
      await enviarTexto(phone, '❌ Peso inválido. Ex: *peso 75.2*');
      return true;
    }
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabase.from('pesos').select('id').eq('user_id', user.id).eq('data', hoje).maybeSingle();
    if (existing) {
      await supabase.from('pesos').update({ peso_kg: v }).eq('id', existing.id);
    } else {
      await supabase.from('pesos').insert({ grupo_id: grupoId, user_id: user.id, data: hoje, peso_kg: v });
    }
    await enviarTexto(phone, `⚖️ Peso de hoje registrado: *${v} kg*`);
    return true;
  }

  // ── ÁGUA ─────────────────────────────────────────────────────────
  if ((m = msg.match(/^(?:bebi|tomei)\s+(\d+)\s*ml(?:\s+de\s+(?:agua|água))?$/i))) {
    const ml = parseInt(m[1]);
    if (!ml || ml > 5000) { await enviarTexto(phone, '❌ Quantidade inválida. Ex: *bebi 500ml de água*'); return true; }
    await supabase.from('agua_registros').insert({
      grupo_id: grupoId, user_id: user.id, data: new Date().toISOString().slice(0, 10), ml,
    });
    // Soma do dia
    const { data: hoje } = await supabase.from('agua_registros').select('ml').eq('user_id', user.id).eq('data', new Date().toISOString().slice(0, 10));
    const total = (hoje || []).reduce((s, r) => s + r.ml, 0);
    const { data: meta } = await supabase.from('metas_nutricao').select('agua_ml').eq('user_id', user.id).maybeSingle();
    const metaAgua = meta?.agua_ml || 2000;
    const litros = (total / 1000).toFixed(2);
    const pct = Math.round((total / metaAgua) * 100);
    await enviarTexto(phone, `💧 +${ml}ml registrado.\n📊 Hoje: *${litros}L* / ${(metaAgua/1000).toFixed(1)}L (${pct}%)${pct >= 100 ? '\n✅ Meta batida!' : ''}`);
    return true;
  }

  // ── TREINO ───────────────────────────────────────────────────────
  // "treinei academia 60 min" / "treinei jiu jitsu"
  if ((m = msg.match(/^(?:treinei|fiz\s+treino\s+de)\s+(.+?)(?:\s+(\d+)\s*min)?$/i))) {
    const nomeTreino = m[1].trim();
    const duracao = m[2] ? parseInt(m[2]) : null;
    // Tenta achar no catálogo
    const { data: catalogo } = await supabase.from('treinos').select('*').eq('grupo_id', grupoId).eq('ativo', true).ilike('nome', `%${nomeTreino}%`);
    let treinoId = null;
    if (catalogo && catalogo.length > 0) {
      treinoId = catalogo[0].id;
    } else {
      // Cria automaticamente
      const { data: novo } = await supabase.from('treinos').insert({
        grupo_id: grupoId, nome: nomeTreino, categoria: 'outro', icone: '💪',
      }).select().single();
      treinoId = novo?.id;
    }
    await supabase.from('treino_registros').insert({
      grupo_id: grupoId, user_id: user.id, treino_id: treinoId, treino_nome: nomeTreino,
      data: new Date().toISOString().slice(0, 10), duracao_min: duracao,
    });
    await enviarTexto(phone, `💪 Treino registrado: *${nomeTreino}*${duracao ? ` · ${duracao} min` : ''}`);
    return true;
  }

  // ── LISTAR MEDICAMENTOS ──────────────────────────────────────────
  if (/^(meus\s+remedios|medicamentos|meus\s+medicamentos)$/i.test(msg)) {
    const { data: meds } = await supabase.from('medicamentos').select('*').eq('grupo_id', grupoId).eq('ativo', true);
    if (!meds?.length) { await enviarTexto(phone, '💊 Nenhum medicamento cadastrado.'); return true; }
    const linhas = meds.map(med => {
      const horarios = (med.horarios || []).map(h => h.slice(0, 5)).join(', ');
      const est = med.estoque_atual != null ? ` · ${med.estoque_atual} restantes` : '';
      return `💊 *${med.nome}* ${med.dosagem || ''} — ${horarios || 'sem horários'}${est}`;
    });
    await enviarTexto(phone, `📋 *Seus medicamentos*\n\n${linhas.join('\n')}`);
    return true;
  }

  // ── LISTAR CONSULTAS ─────────────────────────────────────────────
  if (/^(minha\s+agenda|proximas\s+consultas|próximas\s+consultas|consultas)$/i.test(msg)) {
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: cs } = await supabase.from('consultas').select('*')
      .eq('grupo_id', grupoId).eq('status', 'agendada').gte('data', hoje)
      .order('data').limit(10);
    if (!cs?.length) { await enviarTexto(phone, '📅 Nenhuma consulta agendada.'); return true; }
    const linhas = cs.map(c => {
      const d = new Date(c.data + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
      return `📅 *${c.especialidade || c.profissional || 'Consulta'}* — ${d}${c.hora ? ` · ${c.hora.slice(0,5)}` : ''}${c.local ? ` · ${c.local}` : ''}`;
    });
    await enviarTexto(phone, `🩺 *Próximas consultas*\n\n${linhas.join('\n')}`);
    return true;
  }

  return false; // não reconhecido pela Saúde
};
