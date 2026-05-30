// =============================================================================
// Handler de pendentes — processa respostas a perguntas que a Sora fez antes.
//
// Tipos de pendente:
//   - 'escolher_conta'    → user responde "1", "Nubank" pra indicar a conta
//                           da transação criada sem destino
//   - 'marcar_principal'  → user responde "sim/não" pra marcar a conta como
//                           padrão futura
//   - 'criar_conta'       → user manda "nubank 1000" pra criar 1ª conta
//                           e migrar a transação temp pra ela
//
// Retorna `true` se conseguiu processar (e a mensagem NÃO deve continuar
// pra IA), `false` caso contrário.
// =============================================================================

const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const { criarPendente, removerPendente } = require('../services/pendentes');

const TIPOS_CONTA = ['Corrente', 'Poupança', 'Vale Alimentação', 'Dinheiro'];
const BANDEIRAS   = ['Visa', 'Mastercard', 'Elo', 'Amex', 'Hipercard'];

// Próximo campo a perguntar pra criar_cartao
function proximoCampoCartao(faltam, atual) {
  const idx = faltam.indexOf(atual);
  return faltam[idx + 1] || null;
}

const PERGUNTAS_CARTAO = {
  limite:         '💰 Qual o *limite total* do cartão?',
  dia_fechamento: '📅 Em qual *dia fecha a fatura*? (1 a 28)',
  dia_vencimento: '📅 E qual *dia vence*? (1 a 28)',
  bandeira:       '💳 Qual a *bandeira*?\n1️⃣ Visa  2️⃣ Mastercard  3️⃣ Elo  4️⃣ Amex  5️⃣ Hipercard\nOu responda *pular* se não quiser informar.',
};

// Move uma transação de uma carteira pra outra, reajustando saldos.
async function moverCarteira(txId, novaCarteiraNome, grupoId) {
  const { data: tx } = await supabase
    .from('transacoes').select('*').eq('id', txId).single();
  if (!tx) return false;

  const mult = tx.tipo === 'Gasto' ? -1 : 1;

  // Reverte saldo da carteira antiga
  const { data: walletAntiga } = await supabase
    .from('wallets').select('id, saldo')
    .eq('grupo_id', grupoId).ilike('nome', tx.carteira_nome).single();
  if (walletAntiga) {
    await supabase.from('wallets')
      .update({ saldo: walletAntiga.saldo - (tx.valor * mult) })
      .eq('id', walletAntiga.id);
  }

  // Aplica saldo na nova
  const { data: walletNova } = await supabase
    .from('wallets').select('id, saldo')
    .eq('grupo_id', grupoId).ilike('nome', novaCarteiraNome).single();
  if (walletNova) {
    await supabase.from('wallets')
      .update({ saldo: walletNova.saldo + (tx.valor * mult) })
      .eq('id', walletNova.id);
  }

  await supabase.from('transacoes')
    .update({ carteira_nome: novaCarteiraNome })
    .eq('id', txId);

  return true;
}

/**
 * Tenta resolver uma pendente com base na mensagem do usuário.
 * Retorna true se resolveu (ou consumiu a mensagem), false se a mensagem
 * não tem relação com a pendente (aí o webhook segue normalmente).
 */
async function resolverPendente(pendente, mensagem, ctx) {
  const { phone, grupoId, user } = ctx;
  const msg = (mensagem || '').trim();
  const lower = msg.toLowerCase();

  // ─── TIPO 1: ESCOLHER_CONTA ────────────────────────────────────
  if (pendente.tipo_pergunta === 'escolher_conta') {
    const opcoes = pendente.contexto?.opcoes || [];
    let escolhida = null;

    // Tenta interpretar como número (1, 2, 3...)
    const num = parseInt(msg, 10);
    if (!isNaN(num) && num >= 1 && num <= opcoes.length) {
      escolhida = opcoes[num - 1];
    } else {
      // Ou como nome (case-insensitive, match parcial)
      escolhida = opcoes.find((o) =>
        o.nome.toLowerCase() === lower ||
        o.nome.toLowerCase().includes(lower) ||
        lower.includes(o.nome.toLowerCase())
      );
    }

    if (!escolhida) {
      // Mensagem não bate com nenhuma conta — pode ser um novo gasto, deixa seguir
      return false;
    }

    const txId = pendente.contexto?.transacao_id;
    if (txId) {
      await moverCarteira(txId, escolhida.nome, grupoId);
    }
    await removerPendente(pendente.id);

    await enviarTexto(phone,
      `✅ Atualizei pra *${escolhida.nome}*!\n\n` +
      `⭐ Quer marcar *${escolhida.nome}* como sua conta principal?\n` +
      `Assim eu uso ela automaticamente quando você não disser o banco.\n\n` +
      `Responde *sim* ou *não*.`
    );

    // Cria pendente seguinte (marcar_principal)
    if (user?.id) {
      await criarPendente({
        userId: user.id,
        tipoPergunta: 'marcar_principal',
        contexto: { wallet_id: escolhida.id, wallet_nome: escolhida.nome },
      });
    }
    return true;
  }

  // ─── PAGAR PARCELA: ESCOLHER CONTA ─────────────────────────────
  if (pendente.tipo_pergunta === 'pagar_parcela_conta') {
    const opcoes = pendente.contexto?.opcoes || [];
    const ids    = pendente.contexto?.ids || [];
    const termo  = pendente.contexto?.termo || 'compra';
    let escolhida = null;

    const num = parseInt(msg, 10);
    if (!isNaN(num) && num >= 1 && num <= opcoes.length) {
      escolhida = opcoes[num - 1];
    } else {
      escolhida = opcoes.find((o) =>
        o.nome.toLowerCase() === lower ||
        o.nome.toLowerCase().includes(lower) ||
        lower.includes(o.nome.toLowerCase())
      );
    }
    if (!escolhida) return false; // não bate com conta — deixa seguir

    // Soma só as ainda em aberto e marca como pagas
    const { data: parcelas } = await supabase.from('transacoes')
      .select('id, valor, pago').eq('grupo_id', grupoId).in('id', ids);
    const emAberto = (parcelas || []).filter(p => p.pago === false);
    const total = emAberto.reduce((s, p) => s + (p.valor || 0), 0);

    if (emAberto.length) {
      await supabase.from('transacoes').update({ pago: true }).in('id', emAberto.map(p => p.id));
      // Debita o saldo da conta escolhida
      const { data: conta } = await supabase.from('wallets')
        .select('id, saldo').eq('id', escolhida.id).maybeSingle();
      if (conta) {
        await supabase.from('wallets')
          .update({ saldo: (conta.saldo || 0) - total }).eq('id', conta.id);
      }
    }
    await removerPendente(pendente.id);
    const ehFatura = pendente.contexto?.modo === 'fatura';
    await enviarTexto(phone, ehFatura
      ? `✅ *Fatura paga!*\n💸 R$ ${total.toFixed(2)} debitado de *${escolhida.nome}* · limite do cartão liberado.`
      : `✅ Antecipei *${emAberto.length}* parcela(s) de *"${termo}"*.\n` +
        `💸 R$ ${total.toFixed(2)} debitado de *${escolhida.nome}* · limite do cartão liberado.`
    );
    return true;
  }

  // ─── TIPO 2: MARCAR_PRINCIPAL ──────────────────────────────────
  if (pendente.tipo_pergunta === 'marcar_principal') {
    const positivo = /^(s(im)?|y|yes|claro|marca|pode|positivo|aham|uhum|ok)$/i.test(lower);
    const negativo = /^(n(ao|ão)?|nope|negativo|deixa|tanto faz)$/i.test(lower);

    if (positivo) {
      const walletId = pendente.contexto?.wallet_id;
      const walletNome = pendente.contexto?.wallet_nome;
      if (walletId && user?.id) {
        await supabase.from('users')
          .update({ wallet_padrao_id: walletId })
          .eq('id', user.id);
      }
      await removerPendente(pendente.id);
      await enviarTexto(phone,
        `✅ *${walletNome}* agora é sua conta principal.\n\n` +
        `Da próxima vez é só falar o gasto que eu sei de onde tirar 😉`
      );
      return true;
    }
    if (negativo) {
      await removerPendente(pendente.id);
      await enviarTexto(phone,
        `Beleza. Vou continuar perguntando quando você não disser a conta.\n` +
        `Pode mudar isso quando quiser em forsora.com/contas-bancarias.`
      );
      return true;
    }
    // Resposta não interpretada — deixa pendente expirar e segue normal
    return false;
  }

  // ─── TIPO: TIPO_CONTA (mudar tipo após criar conta corrente default) ─
  if (pendente.tipo_pergunta === 'tipo_conta') {
    let novoTipo = null;
    if (/^poup/i.test(lower))                     novoTipo = 'Poupança';
    else if (/^(va|vale|alelo|sodexo|ticket|refei)/i.test(lower)) novoTipo = 'Vale Alimentação';
    else if (/^(dinheiro|carteira|cash)/i.test(lower)) novoTipo = 'Dinheiro';
    else if (/^corrente/i.test(lower))            novoTipo = 'Corrente';

    if (!novoTipo) return false; // não é resposta — deixa seguir

    const walletId = pendente.contexto?.wallet_id;
    const walletNome = pendente.contexto?.wallet_nome;
    if (walletId) {
      await supabase.from('wallets').update({ tipo: novoTipo }).eq('id', walletId);
    }
    await removerPendente(pendente.id);
    await enviarTexto(phone,
      `✓ Atualizei *${walletNome}* pra *${novoTipo}*.`
    );
    return true;
  }

  // ─── TIPO: CRIAR_CARTAO (wizard sequencial de cartão) ──────────
  if (pendente.tipo_pergunta === 'criar_cartao') {
    const { wallet_id, wallet_nome, faltam, campo_atual } = pendente.contexto || {};
    if (!wallet_id || !campo_atual) return false;

    let valorCampo = null;

    // Parse da resposta conforme o campo
    if (campo_atual === 'limite') {
      const num = parseFloat(msg.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
      if (isNaN(num) || num <= 0) {
        await enviarTexto(phone, `❌ Não entendi o valor. Tenta de novo (ex: 5000):`);
        return true; // consome a mensagem mas mantém a pendente
      }
      valorCampo = num;
    } else if (campo_atual === 'dia_fechamento' || campo_atual === 'dia_vencimento') {
      const dia = parseInt(msg.replace(/[^\d]/g, ''), 10);
      if (isNaN(dia) || dia < 1 || dia > 28) {
        await enviarTexto(phone, `❌ Dia inválido. Use um número de 1 a 28:`);
        return true;
      }
      valorCampo = dia;
    } else if (campo_atual === 'bandeira') {
      if (/^(pular|pula|skip|n)/i.test(lower)) {
        valorCampo = null; // pular bandeira
      } else {
        const num = parseInt(lower, 10);
        if (!isNaN(num) && num >= 1 && num <= BANDEIRAS.length) {
          valorCampo = BANDEIRAS[num - 1];
        } else {
          const match = BANDEIRAS.find((b) => b.toLowerCase() === lower);
          if (match) valorCampo = match;
          else {
            await enviarTexto(phone, `❌ Bandeira não reconhecida. Responde 1-5 ou nome (visa/mastercard/elo/amex/hipercard), ou *pular*.`);
            return true;
          }
        }
      }
    }

    // Aplica a atualização no banco
    if (valorCampo !== null) {
      await supabase.from('wallets').update({ [campo_atual]: valorCampo }).eq('id', wallet_id);
    }

    // Próximo campo ou fim
    const proximo = proximoCampoCartao(faltam, campo_atual);

    if (proximo) {
      // Atualiza a pendente
      await supabase.from('transacoes_pendentes')
        .update({ contexto: { ...pendente.contexto, campo_atual: proximo } })
        .eq('id', pendente.id);

      await enviarTexto(phone, PERGUNTAS_CARTAO[proximo]);
      return true;
    }

    // Fim do wizard — busca dados completos e confirma
    const { data: cartao } = await supabase.from('wallets')
      .select('nome, limite, dia_fechamento, dia_vencimento, bandeira')
      .eq('id', wallet_id).single();

    await removerPendente(pendente.id);

    if (!cartao) {
      await enviarTexto(phone, `✅ Cartão *${wallet_nome}* configurado!`);
      return true;
    }

    const linhas = [`💳 *Cartão configurado!*`, ''];
    linhas.push(`🏦 ${cartao.nome}`);
    if (cartao.bandeira)      linhas.push(`💳 Bandeira: ${cartao.bandeira}`);
    if (cartao.limite)        linhas.push(`💰 Limite: R$ ${cartao.limite.toFixed(2)}`);
    if (cartao.dia_fechamento && cartao.dia_vencimento) {
      linhas.push(`📅 Fecha dia ${cartao.dia_fechamento} · Vence dia ${cartao.dia_vencimento}`);
    }

    await enviarTexto(phone, linhas.join('\n'));
    return true;
  }

  // ─── TIPO 3: CRIAR_CONTA ───────────────────────────────────────
  if (pendente.tipo_pergunta === 'criar_conta') {
    // Tenta detectar formato "nome valor" (ex: "nubank 1000", "carteira 50")
    const match = msg.match(/^([a-zA-ZÀ-ÿ\s]+?)\s+([\d.,]+)$/);
    if (!match) return false; // não é resposta — segue normal

    const nome = match[1].trim();
    const saldo = parseFloat(match[2].replace(/\./g, '').replace(',', '.')) || 0;

    // Cria a wallet
    const tipoConta = nome.toLowerCase().includes('crédito') ? 'Crédito'
                    : nome.toLowerCase().includes('carteira') ? 'Dinheiro'
                    : 'Corrente';

    const { data: novaWallet } = await supabase.from('wallets').insert({
      grupo_id: grupoId,
      nome,
      tipo: tipoConta,
      saldo,
    }).select().single();

    if (!novaWallet) {
      await enviarTexto(phone, '❌ Não consegui criar a conta. Tenta de novo ou usa o painel.');
      return true;
    }

    // Move a transação temporária pra essa conta
    const txId = pendente.contexto?.transacao_id;
    if (txId) {
      await moverCarteira(txId, nome, grupoId);
    }

    // Marca como padrão (é a primeira conta)
    if (user?.id) {
      await supabase.from('users')
        .update({ wallet_padrao_id: novaWallet.id })
        .eq('id', user.id);
    }

    await removerPendente(pendente.id);
    await enviarTexto(phone,
      `✅ Conta *${nome}* criada com saldo R$ ${saldo.toFixed(2)}!\n` +
      `✓ Movi a transação anterior pra essa conta\n` +
      `⭐ Definida como sua conta principal\n\n` +
      `Pode mandar seus próximos gastos normalmente — eu já sei de onde tirar 😉`
    );
    return true;
  }

  return false;
}

module.exports = { resolverPendente };
