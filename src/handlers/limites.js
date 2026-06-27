const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');

module.exports = async function handleLimites(data, ctx) {
  const { phone, grupoId, user } = ctx;
  const mesRef = new Date().toISOString().slice(0,7);

  if (data.acao === 'set_limite') {
    const cat = data.categoria.charAt(0).toUpperCase() + data.categoria.slice(1).toLowerCase();
    await supabase.from('category_limits').upsert(
      { grupo_id: grupoId, categoria: cat, limite_mensal: data.valor, mes_referencia: mesRef },
      { onConflict: 'grupo_id,categoria,mes_referencia' }
    );
    await enviarTexto(phone, `🔔 Limite de *${cat}* definido: R$ ${parseFloat(data.valor).toFixed(2)}/mês.`);
    return;
  }

  if (data.acao === 'set_meta') {
    await supabase.from('users').update({ meta_mensal: data.valor }).eq('phone', phone);
    await enviarTexto(phone, `🎯 Meta mensal de gastos: *R$ ${parseFloat(data.valor).toFixed(2)}*.`);
    return;
  }

  if (data.acao === 'meus_limites') {
    const { data: limites } = await supabase.from('category_limits')
      .select('categoria, limite_mensal').eq('grupo_id', grupoId).eq('mes_referencia', mesRef);
    if (!limites?.length) {
      await enviarTexto(phone, 'Nenhum limite definido. Use "limite mercado 500" para criar um.');
      return;
    }
    const lista = limites.map(l => `🔹 *${l.categoria}:* R$ ${l.limite_mensal.toFixed(2)}`).join('\n');
    await enviarTexto(phone, `📊 *Seus limites mensais:*\n\n${lista}`);
  }
};