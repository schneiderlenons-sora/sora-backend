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
      arquivada: false,
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
