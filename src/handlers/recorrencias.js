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

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Lista as contas/receitas fixas do mês — "quais meus gastos fixos desse mês?".
 *
 * Separa em JÁ PASSOU × AINDA VEM pelo dia de hoje: é o que a pergunta quer
 * saber de verdade (quanto ainda vai sair do bolso este mês).
 *
 * ⚠️ Data por `hojeSP()`, nunca `new Date().toISOString()` — este é UTC, e
 * depois das 21h no Brasil o dia já virou; a conta do dia seguinte apareceria
 * como "já passou". Mesma regra do resto do sistema.
 */
async function listarRecorrencias(data, ctx) {
  const { phone, grupoId } = ctx;
  const filtro = data.filtro === 'Gasto' || data.filtro === 'Receita' ? data.filtro : null;

  const cols = 'tipo, categoria, valor, dia_vencimento, descricao';
  let q = supabase.from('recorrencias').select(`${cols}, valor_variavel`)
    .eq('grupo_id', grupoId).eq('ativa', true);
  if (filtro) q = q.eq('tipo', filtro);
  let { data: rows, error } = await q.order('dia_vencimento', { ascending: true });
  // Migration 066 (valor_variavel) pendente → refaz sem ela em vez de quebrar.
  if (error) {
    let q2 = supabase.from('recorrencias').select(cols)
      .eq('grupo_id', grupoId).eq('ativa', true);
    if (filtro) q2 = q2.eq('tipo', filtro);
    ({ data: rows } = await q2.order('dia_vencimento', { ascending: true }));
  }
  const lista = rows || [];

  if (!lista.length) {
    const nada = filtro === 'Gasto' ? 'nenhum gasto fixo cadastrado'
      : filtro === 'Receita' ? 'nenhuma receita fixa cadastrada'
      : 'nenhuma recorrência cadastrada';
    await enviarTexto(phone,
      `🔁 Você tem ${nada}.\n\nPra criar, é só mandar: *todo mês 1000 aluguel dia 5* 📌`);
    return;
  }

  const { hojeSP } = require('../services/cicloFatura');
  const hoje = parseInt(hojeSP().slice(8, 10), 10);

  const linha = (r) => {
    const dia = r.dia_vencimento ? `dia ${String(r.dia_vencimento).padStart(2, '0')}` : 'sem dia';
    // Conta de valor variável não tem valor fixo — exibir um número seria mentir.
    const valor = r.valor_variavel ? '_valor varia_' : brl(r.valor);
    const icone = r.tipo === 'Receita' ? '💰' : '💸';
    return `${icone} *${valor}* · ${String(r.descricao || r.categoria || 'Sem descrição').slice(0, 34)} — ${dia}`;
  };

  const passou = lista.filter((r) => r.dia_vencimento && r.dia_vencimento < hoje);
  const vem    = lista.filter((r) => !r.dia_vencimento || r.dia_vencimento >= hoje);

  // Só soma valor FIXO — variável entra como contagem, não como número inventado.
  const somar = (tipo) => lista
    .filter((r) => r.tipo === tipo && !r.valor_variavel)
    .reduce((s, r) => s + (Number(r.valor) || 0), 0);
  const variaveis = lista.filter((r) => r.valor_variavel).length;

  const titulo = filtro === 'Gasto' ? '💸 *Seus gastos fixos do mês*'
    : filtro === 'Receita' ? '💰 *Suas receitas fixas do mês*'
    : '🔁 *Suas recorrências do mês*';
  const partes = [titulo];

  if (vem.length)    partes.push(`\n*Ainda vem (do dia ${hoje} em diante)*\n${vem.map(linha).join('\n')}`);
  if (passou.length) partes.push(`\n*Já passou neste mês*\n${passou.map(linha).join('\n')}`);

  const totGasto = somar('Gasto');
  const totRec   = somar('Receita');
  const resumo = [];
  if (totGasto > 0 && filtro !== 'Receita') resumo.push(`sai ${brl(totGasto)}`);
  if (totRec   > 0 && filtro !== 'Gasto')   resumo.push(`entra ${brl(totRec)}`);
  if (resumo.length) {
    partes.push(`\n📊 Todo mês ${resumo.join(' e ')}`
      + (variaveis ? `, mais ${variaveis} conta${variaveis > 1 ? 's' : ''} de valor variável.` : '.'));
  }
  // Sobra líquida só faz sentido quando os DOIS lados aparecem.
  if (!filtro && totGasto > 0 && totRec > 0) {
    const sobra = totRec - totGasto;
    partes.push(sobra >= 0
      ? `Sobram ${brl(sobra)} depois das fixas.`
      : `⚠️ As fixas passam das receitas em ${brl(Math.abs(sobra))}.`);
  }

  await enviarTexto(phone, partes.join('\n'));
}

module.exports = async function handleRecorrencias(data, ctx) {
  const { phone, grupoId, user } = ctx;

  if (data.acao === 'listar_recorrencias') return listarRecorrencias(data, ctx);

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