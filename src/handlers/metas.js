// =============================================================================
// Handler de metas financeiras (poupança) no WhatsApp.
//   aporte_meta → "guardar 500 na meta viagem"
// Registra o aporte, atualiza o valor guardado e oferece descontar de uma conta.
// =============================================================================
const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');
const { oferecerDesconto } = require('../services/descontoConta');

const fmt = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

module.exports = async function handleMetas(data, ctx) {
  const { phone, grupoId, user } = ctx;

  if (data.acao === 'aporte_meta') {
    const termo = (data.termo || '').trim();
    const valor = parseFloat(data.valor);
    if (!valor || valor <= 0) {
      await enviarTexto(phone, '❌ Informe o valor. Ex: *guardar 500 na meta viagem*');
      return;
    }

    const { data: metas } = await supabase.from('metas')
      .select('id, titulo, valor_atual, valor_objetivo')
      .eq('grupo_id', grupoId).ilike('titulo', `%${termo}%`);

    if (!metas?.length) {
      await enviarTexto(phone, `❌ Não encontrei meta com *"${termo}"*. Crie no painel: 🌐 forsora.com/metas`);
      return;
    }
    if (metas.length > 1) {
      const lista = metas.map(mt => `• ${mt.titulo}`).join('\n');
      await enviarTexto(phone, `🤔 Mais de uma meta com *"${termo}"*:\n${lista}\n\nSeja mais específico.`);
      return;
    }

    const meta = metas[0];
    const novoValor = parseFloat(meta.valor_atual || 0) + valor;
    const objetivo = parseFloat(meta.valor_objetivo || 0);
    const concluiu = objetivo > 0 && novoValor >= objetivo;

    await supabase.from('meta_aportes').insert({
      meta_id: meta.id, user_id: user?.id, valor, tipo: 'aporte',
      data: new Date().toISOString().slice(0, 10),
    });
    await supabase.from('metas')
      .update({ valor_atual: novoValor, status: concluiu ? 'concluido' : 'ativo', updated_at: new Date().toISOString() })
      .eq('id', meta.id);

    const pct = objetivo > 0 ? Math.min((novoValor / objetivo) * 100, 100) : 0;
    await enviarTexto(phone,
      `🎯 *Aporte na meta ${meta.titulo}!*\n\n` +
      `💰 + ${fmt(valor)}\n` +
      `📊 ${fmt(novoValor)} / ${fmt(objetivo)} (${pct.toFixed(0)}%)` +
      (concluiu ? `\n\n🏆 *Meta concluída! Parabéns!* 🎉` : ''));

    await oferecerDesconto({ user, phone, grupoId, valor, categoria: 'Metas', observacao: `Aporte: ${meta.titulo}` });
    return;
  }
};
