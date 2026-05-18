const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const { nanoid } = require('nanoid');

const LIMITE_MEMBROS = { inativo:1, basico:1, premium:3, black:5 };

module.exports = async function handleGrupos(data, ctx) {
  const { phone, grupoId, user } = ctx;

  if (data.acao === 'criar_grupo') {
    const { data: existe } = await supabase.from('grupos')
      .select('id').eq('dono_id', user.id).eq('nome', data.nome).single();
    if (existe) { await enviarTexto(phone, `❌ Você já tem um grupo chamado *"${data.nome}"*.`); return; }
    const { data: grupo } = await supabase.from('grupos')
      .insert({ nome: data.nome, dono_id: user.id }).select().single();
    await supabase.from('users').update({ grupo_ativo: grupo.id }).eq('id', user.id);
    await enviarTexto(phone, `✅ Grupo *"${data.nome}"* criado! Use "convidar grupo" para gerar um código.`);
    return;
  }

  if (data.acao === 'convidar_grupo') {
    const { data: grupo } = await supabase.from('grupos').select('*').eq('id', grupoId).single();
    if (grupo.dono_id !== user.id) { await enviarTexto(phone, '❌ Só o administrador pode gerar convites.'); return; }
    const codigo = nanoid(6).toUpperCase();
    const expira = new Date(Date.now() + 7*24*60*60*1000);
    await supabase.from('convites').insert({ grupo_id: grupoId, codigo, criado_por: user.id, expira_em: expira.toISOString() });
    await enviarTexto(phone, `🔑 Código de convite: *${codigo}*\nCompartilhe com quem quer convidar. Válido por 7 dias.`);
    return;
  }

  if (data.acao === 'entrar_grupo') {
    const { data: convite } = await supabase.from('convites')
      .select('*, grupos(dono_id)').eq('codigo', data.codigo)
      .eq('usado', false).gte('expira_em', new Date().toISOString()).single();
    if (!convite) { await enviarTexto(phone, '❌ Código inválido ou expirado.'); return; }
    const { data: dono } = await supabase.from('users').select('plano').eq('id', convite.grupos.dono_id).single();
    const { count } = await supabase.from('grupo_membros')
      .select('*', { count:'exact', head:true }).eq('grupo_id', convite.grupo_id);
    if (count >= LIMITE_MEMBROS[dono?.plano || 'basico']) {
      await enviarTexto(phone, '❌ O grupo atingiu o limite de membros do plano atual.'); return;
    }
    await supabase.from('grupo_membros').upsert({ grupo_id: convite.grupo_id, user_id: user.id, papel:'escrita' }, { onConflict:'grupo_id,user_id' });
    await supabase.from('convites').update({ usado: true }).eq('id', convite.id);
    await supabase.from('users').update({ grupo_ativo: convite.grupo_id }).eq('id', user.id);
    const { data: g } = await supabase.from('grupos').select('nome').eq('id', convite.grupo_id).single();
    await enviarTexto(phone, `✅ Você entrou no grupo *"${g.nome}"*! Seus lançamentos serão compartilhados com o grupo.`);
    return;
  }

  if (data.acao === 'meus_grupos') {
    const { data: membros } = await supabase.from('grupo_membros')
      .select('grupo_id, grupos(nome)').eq('user_id', user.id);
    if (!membros?.length) { await enviarTexto(phone, 'Você não participa de nenhum grupo.'); return; }
    const lista = membros.map(m => {
      const ativo = m.grupo_id === grupoId ? ' ✅' : '';
      return `• ${m.grupos.nome}${ativo}`;
    }).join('\n');
    await enviarTexto(phone, `📋 *Seus grupos:*\n\n${lista}\n\nUse "trocar grupo Nome" para alternar.`);
    return;
  }

  if (data.acao === 'trocar_grupo') {
    const { data: membro } = await supabase.from('grupo_membros')
      .select('grupo_id, grupos(id, nome)').eq('user_id', user.id)
      .ilike('grupos.nome', data.nome).single();
    if (!membro) { await enviarTexto(phone, `❌ Grupo *"${data.nome}"* não encontrado.`); return; }
    await supabase.from('users').update({ grupo_ativo: membro.grupo_id }).eq('id', user.id);
    await enviarTexto(phone, `✅ Grupo ativo alterado para *"${membro.grupos.nome}"*.`);
    return;
  }

  if (data.acao === 'listar_membros') {
    const { data: membros } = await supabase.from('grupo_membros')
      .select('papel, users(name)').eq('grupo_id', grupoId);
    const lista = membros?.map(m => {
      const p = m.papel==='admin'?'👑 Admin': m.papel==='leitura'?'👀 Leitura':'✍️ Escrita';
      return `${p} — ${m.users.name}`;
    }).join('\n');
    await enviarTexto(phone, `👥 *Membros do grupo:*\n\n${lista}`);
    return;
  }

  if (data.acao === 'remover_membro') {
    const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).single();
    if (grupo.dono_id !== user.id) { await enviarTexto(phone, '❌ Só o administrador pode remover membros.'); return; }
    const { data: membros } = await supabase.from('grupo_membros')
      .select('user_id, users(name)').eq('grupo_id', grupoId);
    const alvo = membros?.find(m => m.users.name.toLowerCase().includes(data.nome.toLowerCase()));
    if (!alvo) { await enviarTexto(phone, `❌ Membro *"${data.nome}"* não encontrado.`); return; }
    await supabase.from('grupo_membros').delete().eq('grupo_id', grupoId).eq('user_id', alvo.user_id);
    await enviarTexto(phone, `🗑️ *${alvo.users.name}* removido do grupo.`);
  }
};