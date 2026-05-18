const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');

module.exports = async function handleRecorrencias(data, ctx) {
  const { phone, grupoId } = ctx;

  if (data.acao === 'set_recorrente') {
    await supabase.from('recorrencias').insert({
      grupo_id: grupoId, tipo: data.tipo || 'Gasto',
      valor: data.valor, dia_vencimento: data.dia,
      descricao: data.descricao, carteira: data.carteira || 'Dinheiro', ativa: true
    });
    await enviarTexto(phone, `📌 *Agendado!* R$ ${parseFloat(data.valor).toFixed(2)} - ${data.descricao} todo dia *${data.dia}*.`);
    return;
  }

  if (data.acao === 'cancelar_recorrencia') {
    const { data: rec } = await supabase.from('recorrencias')
      .select('id, descricao').eq('grupo_id', grupoId)
      .ilike('descricao', `%${data.descricao}%`).eq('ativa', true).single();
    if (!rec) {
      await enviarTexto(phone, `❌ Recorrência *"${data.descricao}"* não encontrada.`);
      return;
    }
    await supabase.from('recorrencias').update({ ativa: false }).eq('id', rec.id);
    await enviarTexto(phone, `✅ Recorrência *"${rec.descricao}"* cancelada.`);
    return;
  }

  if (data.acao === 'criar_lembrete') {
    const dataVenc = new Date(new Date().getFullYear(), data.mes, data.dia);
    if (dataVenc < new Date()) dataVenc.setFullYear(dataVenc.getFullYear() + 1);
    await supabase.from('lembretes').insert({
      grupo_id: grupoId, descricao: data.descricao, valor: data.valor,
      tipo: data.tipo, data_vencimento: dataVenc.toISOString()
    });
    await enviarTexto(phone, `🔔 Lembrete criado: ${data.tipo === 'pagar' ? '💸' : '💰'} *${data.descricao}* - R$ ${parseFloat(data.valor).toFixed(2)} em ${dataVenc.toLocaleDateString('pt-BR')}`);
  }
};