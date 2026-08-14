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
const { ehPagamentoFatura } = require('../services/categorizar');
const { enviarTexto } = require('../services/mensageiro');
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

  // ─── DETETIVE WATSON: escolher e apagar a cópia duplicada ──────
  if (pendente.tipo_pergunta === 'escolher_duplicada'
      || pendente.tipo_pergunta === 'confirmar_exclusao_dup') {
    const { resolverDuplicada } = require('./duplicadas');
    return resolverDuplicada(pendente, msg, phone);
  }

  // ─── ROLAR FATURA (rollover do cartão, migration 096) ──────────
  if (pendente.tipo_pergunta === 'rolar_fatura') {
    const { rollover_id, cartao_nome, valor } = pendente.contexto || {};
    if (/^(s|sim|pode|rola(r)?|isso|claro|quero|ok|beleza|manda|confirmo|👍)/i.test(lower)) {
      try {
        const { materializarRollover } = require('../services/faturaRollover');
        const { data: row } = await supabase.from('fatura_rollover').select('*').eq('id', rollover_id).maybeSingle();
        if (row && row.status === 'aguardando') {
          // O cartão traz os dias do ciclo — o "Fatura anterior" é ancorado no
          // INÍCIO do ciclo seguinte (senão pode cair na fatura errada).
          const { data: cartao } = await supabase.from('wallets')
            .select('id, nome, dia_fechamento, dia_vencimento').eq('id', row.cartao_id).maybeSingle();
          await materializarRollover(row, cartao?.nome || cartao_nome || 'cartão', cartao);
        }
        await removerPendente(pendente.id);
        await enviarTexto(phone, `✅ Pronto! Rolei R$ ${Number(valor || 0).toFixed(2)} pra próxima fatura do ${cartao_nome || 'cartão'}.`);
      } catch (e) {
        await removerPendente(pendente.id);
        await enviarTexto(phone, `⚠️ Não consegui rolar agora: ${e.message}`);
      }
      return true;
    }
    if (/^(n|n[ãa]o|nao|depois|espera|ainda|vou pagar|deixa)/i.test(lower)) {
      await removerPendente(pendente.id);
      await enviarTexto(phone, '👍 Beleza. Se o restante não for pago, eu rolo pra próxima fatura automaticamente no fim do prazo.');
      return true;
    }
    return false; // não bate — deixa a mensagem seguir (pode ser outra coisa)
  }

  // ─── PARCELAMENTO: já pagou a 1ª parcela? (migration 097 / sem cartão) ──
  if (pendente.tipo_pergunta === 'parcelamento_primeira') {
    const { divida_id, titulo, valor_parcela, parcelas_total } = pendente.contexto || {};
    if (/^(s|sim|paguei|já|ja|paga|foi|isso|claro|ok)/i.test(lower)) {
      try {
        // Marca a 1ª parcela como paga: registra o pagamento + incrementa contador.
        await supabase.from('divida_pagamentos').insert({
          divida_id, user_id: user?.id, numero_parcela: 1,
          valor: valor_parcela || 0, tipo: 'parcela',
          data_pagamento: new Date().toISOString().slice(0, 10),
        });
        await supabase.from('dividas').update({ parcelas_pagas: 1 }).eq('id', divida_id);
      } catch { /* noop */ }
      await removerPendente(pendente.id);
      await enviarTexto(phone, `✅ Anotei a *1ª parcela* de ${titulo || 'parcelamento'} como paga. Faltam ${Math.max(0, (parcelas_total || 1) - 1)}.`);
      return true;
    }
    if (/^(n|n[ãa]o|nao|ainda n|nada|zero)/i.test(lower)) {
      await removerPendente(pendente.id);
      await enviarTexto(phone, '👍 Beleza, deixei todas as parcelas em aberto. Vou te lembrar no vencimento.');
      return true;
    }
    return false; // não bate — deixa a mensagem seguir
  }

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

  // ─── DESCONTAR_DESTINO: descontar aporte/pagamento de uma conta ─
  if (pendente.tipo_pergunta === 'descontar_destino') {
    const opcoes = pendente.contexto?.opcoes || [];
    const { valor, categoria, observacao } = pendente.contexto || {};

    // Negativa → deixa só o registro
    if (/^(n|n[ãa]o|nao quero|deixa|depois|tanto faz|nem)$/i.test(lower)) {
      await removerPendente(pendente.id);
      await enviarTexto(phone, '👍 Beleza, deixei só o registro — não descontei de nenhuma conta.');
      return true;
    }

    const num = parseInt(msg, 10);

    // "Pago por outra pessoa" (só quando permiteExterno, ex.: fatura): registra
    // sem descontar de conta nenhuma. É a opção nº (opcoes.length + 1) ou texto.
    const permiteExterno = !!pendente.contexto?.permiteExterno;
    const externoNum = opcoes.length + 1;
    const pediuExterno = permiteExterno && (
      (!isNaN(num) && num === externoNum) ||
      /(outra pessoa|outra conta|algu[eé]m|alguem|terceiro|externo|amigo|esposa|marido|namorad|\bpai\b|m[ãa]e|filho|por fora|nao ?fui eu|não ?fui eu)/i.test(lower)
    );
    if (pediuExterno) {
      let tx = null;
      try {
        const { registrarFaturaExterna } = require('../services/contaDebito');
        const r = await registrarFaturaExterna({
          grupoId, valor,
          observacao: `${observacao || 'Fatura'} — paga por outra pessoa`,
          userId: user?.id,
        });
        tx = r?.tx;
      } catch (e) { /* tolerante */ }
      const { cartao_id, competencia } = pendente.contexto || {};
      if (cartao_id && competencia) {
        try {
          await supabase.from('pagamentos_fatura').insert({
            grupo_id: grupoId, user_id: user?.id, cartao_id, competencia,
            valor: Number(valor) || 0, transacao_id: tx?.id || null,
          });
        } catch { /* tolerante à migration 096 */ }
      }
      await removerPendente(pendente.id);
      await enviarTexto(phone,
        `✅ Anotei que *R$ ${Number(valor || 0).toFixed(2)}* foi *pago por outra pessoa*. ` +
        `Não descontei de nenhuma conta — só registrei nas suas transações 📊`);
      return true;
    }

    // Escolha por número ou nome
    let escolhida = null;
    if (!isNaN(num) && num >= 1 && num <= opcoes.length) escolhida = opcoes[num - 1];
    else escolhida = opcoes.find((o) =>
      o.nome.toLowerCase() === lower ||
      o.nome.toLowerCase().includes(lower) ||
      lower.includes(o.nome.toLowerCase()));
    if (!escolhida) return false; // não bate com conta — deixa seguir

    let debito = null;
    try {
      const { debitarConta } = require('../services/contaDebito');
      debito = await debitarConta({ grupoId, walletId: escolhida.id, valor, categoria, observacao, userId: user?.id });
    } catch (e) {
      await removerPendente(pendente.id);
      await enviarTexto(phone, `⚠️ Não consegui descontar de *${escolhida.nome}*: ${e.message}`);
      return true;
    }
    // Pagamento de FATURA (contexto com cartao_id): registra pagamentos_fatura
    // pra o painel refletir o "restante" (igual ao pagamento pelo painel).
    const { cartao_id, competencia } = pendente.contexto || {};
    if (cartao_id && competencia) {
      try {
        await supabase.from('pagamentos_fatura').insert({
          grupo_id: grupoId, user_id: user?.id, cartao_id, competencia,
          valor: Number(valor) || 0, transacao_id: debito?.tx?.id || null,
        });
      } catch { /* tolerante à migration 096 */ }
    }
    await removerPendente(pendente.id);
    const ehFatura = ehPagamentoFatura(categoria);
    await enviarTexto(phone,
      (ehFatura
        ? `✅ *Pagamento da fatura registrado!* Debitei *R$ ${Number(valor || 0).toFixed(2)}* de *${escolhida.nome}*.`
        : `✅ Descontei *R$ ${Number(valor || 0).toFixed(2)}* de *${escolhida.nome}*.`) +
      `\nJá aparece nas suas transações 📊`);
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
