const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');

// Insert tolerante a coluna criado_por ausente (pré-migration 052): tenta com
// o dono; se a coluna ainda não existe, refaz sem ela (não quebra a criação).
async function inserirComDono(tabela, base, donoId) {
  const { error } = await supabase.from(tabela).insert({ ...base, criado_por: donoId || null });
  if (error) await supabase.from(tabela).insert(base);
}

module.exports = async function handleRecorrencias(data, ctx) {
  const { phone, grupoId, user } = ctx;

  if (data.acao === 'set_recorrente') {
    const valorNum = parseFloat(data.valor);
    const temValor = !isNaN(valorNum) && valorNum > 0;
    const diaOk = Number.isInteger(data.dia) && data.dia >= 1 && data.dia <= 31;

    // Sem dia (ou valor) válido NÃO salva — senão vira "todo dia null" / "R$ NaN".
    // Pede o que falta, como já faz o fluxo de lembrete.
    if (!diaOk || !temValor) {
      const desc = data.descricao || 'a recorrência';
      const exVal = temValor ? valorNum.toFixed(2).replace('.', ',') : '72,80';
      const exDesc = data.descricao || 'Netflix';
      await enviarTexto(phone,
        `🔁 Quase! Pra agendar *${desc}* todo mês eu preciso ${!temValor ? 'do *valor* e ' : ''}do *dia* em que cai.\n\n` +
        `Manda assim, por exemplo:\n*todo mês ${exVal} ${exDesc} dia 10*`);
      return;
    }

    await inserirComDono('recorrencias', {
      grupo_id: grupoId, tipo: data.tipo || 'Gasto',
      valor: valorNum, dia_vencimento: data.dia,
      descricao: data.descricao, carteira: data.carteira || 'Dinheiro', ativa: true
    }, user?.id);
    const ondeTxt = data.carteira ? ` no *${data.carteira}*` : '';
    await enviarTexto(phone, `📌 *Agendado!* R$ ${valorNum.toFixed(2)} — ${data.descricao} todo dia *${data.dia}*${ondeTxt}.`);
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
    const valorNum = parseFloat(data.valor);
    const temValor = !isNaN(valorNum) && valorNum > 0;
    const diaOk = Number.isInteger(data.dia) && data.dia >= 1 && data.dia <= 31;
    // Sem dia válido = provável interpretação errada. Em vez de salvar lixo
    // (R$ NaN / 31/12), orienta o usuário.
    if (!diaOk) {
      await enviarTexto(phone,
        '🔔 Pra eu criar um lembrete de conta, me diz o dia. Ex.: *lembrete pagar internet dia 10*.\n\n' +
        'Se você quis anotar na lista de compras, manda *comprar pão e café* 🛒');
      return;
    }
    const mes = Number.isInteger(data.mes) ? data.mes : new Date().getMonth();
    const dataVenc = new Date(new Date().getFullYear(), mes, data.dia);
    if (dataVenc < new Date()) dataVenc.setFullYear(dataVenc.getFullYear() + 1);
    await inserirComDono('lembretes', {
      grupo_id: grupoId, descricao: data.descricao, valor: temValor ? valorNum : null,
      tipo: data.tipo, data_vencimento: dataVenc.toISOString()
    }, user?.id);
    await enviarTexto(phone, `🔔 Lembrete criado: ${data.tipo === 'pagar' ? '💸' : '💰'} *${data.descricao}*${temValor ? ` - R$ ${valorNum.toFixed(2)}` : ''} em ${dataVenc.toLocaleDateString('pt-BR')}`);
  }
};