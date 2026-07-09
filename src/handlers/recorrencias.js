const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');

const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const semPrefixo = (obs) => (obs || '').replace(/^\[previsto\]\s*/i, '').trim();

// Insert tolerante a coluna criado_por ausente (pré-migration 052): tenta com
// o dono; se a coluna ainda não existe, refaz sem ela (não quebra a criação).
async function inserirComDono(tabela, base, donoId) {
  const { error } = await supabase.from(tabela).insert({ ...base, criado_por: donoId || null });
  if (error) await supabase.from(tabela).insert(base);
}

module.exports = async function handleRecorrencias(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // ── CONFIRMAR PREVISTO (conta variável) ────────────────────────────────
  // "confirmar luz 243" → acha o lançamento PREVISTO/pendente da conta variável,
  // grava o valor real, marca como pago e debita/credita a carteira.
  if (data.acao === 'confirmar_previsto') {
    const termo = (data.termo || '').trim();
    const valor = parseFloat(data.valor);

    const { data: previstos } = await supabase.from('transacoes')
      .select('id, id_curto, tipo, valor, observacao, carteira_nome')
      .eq('grupo_id', grupoId).eq('pago', false)
      .ilike('observacao', '[Previsto]%')
      .order('data', { ascending: false });
    const lista = previstos || [];

    if (!lista.length) {
      await enviarTexto(phone, '🔎 Você não tem contas *previstas* em aberto pra confirmar agora.');
      return;
    }

    const listar = () => lista.map((t) => `• ${semPrefixo(t.observacao)} — \`${t.id_curto}\``).join('\n');

    // Match por ID (6 alfanum) ou por descrição.
    let alvo = null;
    if (/^[a-z0-9]{6}$/i.test(termo)) {
      alvo = lista.find((t) => (t.id_curto || '').toLowerCase() === termo.toLowerCase());
    }
    if (!alvo) {
      const tn = norm(termo);
      const cands = lista.filter((t) => {
        const d = norm(semPrefixo(t.observacao));
        return d && (d.includes(tn) || tn.includes(d));
      });
      if (cands.length === 1) alvo = cands[0];
      else if (cands.length > 1) {
        await enviarTexto(phone,
          `Achei mais de uma conta prevista com *"${termo}"*. Confirma pelo ID:\n` +
          cands.map((t) => `• ${semPrefixo(t.observacao)} — \`${t.id_curto}\``).join('\n') +
          `\n\nEx.: *confirmar ${cands[0].id_curto} ${isNaN(valor) ? '243' : valor.toFixed(2).replace('.', ',')}*`);
        return;
      }
    }

    if (!alvo) {
      await enviarTexto(phone,
        `🔎 Não achei a conta prevista *"${termo}"* em aberto.\n\nSuas previstas em aberto:\n${listar()}\n\n` +
        `Responda: *confirmar <nome> <valor>*`);
      return;
    }
    if (isNaN(valor) || valor <= 0) {
      await enviarTexto(phone, `❌ Qual o valor? Ex.: *confirmar ${semPrefixo(alvo.observacao)} 243*`);
      return;
    }

    const descLimpa = semPrefixo(alvo.observacao);
    await supabase.from('transacoes')
      .update({ valor, pago: true, observacao: descLimpa }).eq('id', alvo.id);

    const ehGasto = alvo.tipo === 'Gasto';
    const mult = ehGasto ? -1 : 1;
    const { data: wallet } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', alvo.carteira_nome || 'Dinheiro').maybeSingle();
    if (wallet) {
      await supabase.from('wallets').update({ saldo: (wallet.saldo || 0) + (valor * mult) }).eq('id', wallet.id);
    }

    const linhaConta = wallet
      ? ` · ${ehGasto ? 'debitado de' : 'creditado em'} *${alvo.carteira_nome}*`
      : '';
    await enviarTexto(phone,
      `✅ *Confirmado!* ${ehGasto ? '🔴' : '🟢'} ${descLimpa} — R$ ${valor.toFixed(2)}${linhaConta}.`);
    return;
  }

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