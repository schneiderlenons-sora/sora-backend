const supabase = require('../db/supabase');
const { enviarTexto, enviarBotaoLink } = require('../services/mensageiro');
const { criarPendente } = require('../services/pendentes');

// Soma os gastos de uma carteira (conta/cartão) num intervalo [ini, fimExcl).
// excluirTransfer = ignora transferências (elas não são gasto de verdade).
async function somarGastosCarteira(grupoId, nome, ini, fimExcl, excluirTransfer = false) {
  const { data } = await supabase.from('transacoes')
    .select('valor, transferencia')
    .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
    .ilike('carteira_nome', nome).gte('data', ini).lt('data', fimExcl);
  return (data || [])
    .filter(t => !(excluirTransfer && t.transferencia))
    .reduce((s, t) => s + (t.valor || 0), 0);
}

// Tipos válidos de conta
const TIPOS_CONTA = ['Corrente', 'Poupança', 'Vale Alimentação', 'Dinheiro'];
const BANDEIRAS = ['Visa', 'Mastercard', 'Elo', 'Amex', 'Hipercard'];

// Nomes oficiais dos bancos
const BANCOS = {
  'nubank':'Nubank','inter':'Inter','itau':'Itaú','itaú':'Itaú',
  'bradesco':'Bradesco','santander':'Santander','caixa':'Caixa',
  'c6 bank':'C6 Bank','c6bank':'C6 Bank','mercado pago':'Mercado Pago',
  'picpay':'Picpay','banco do brasil':'Banco do Brasil','safra':'Safra',
  'dinheiro':'Dinheiro'
};

// Normaliza nome do banco: "NUBANK CREDITO" → "Nubank Crédito"
function normalizarBanco(nome) {
  const lower = nome.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace('credito','crédito').trim();

  const ehCredito = lower.includes('crédito');
  const base      = lower.replace('crédito','').trim();
  const nomeOficial = BANCOS[base];

  if (!nomeOficial) return null; // banco não reconhecido
  return ehCredito ? `${nomeOficial} Crédito` : nomeOficial;
}

// Limite de contas por plano
function limitePorPlano(plano) {
  if (plano === 'premium' || plano === 'black') return Infinity;
  return 3; // básico
}

module.exports = async function handleWallets(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // ── CRIAR / DEFINIR SALDO ───────────────────────────────────────
  if (data.acao === 'set_wallet') {
    const nomeFinal = normalizarBanco(data.nome);
    if (!nomeFinal) {
      await enviarTexto(phone, `⚠️ *"${data.nome}"* não é um banco reconhecido.\nUse: Nubank, Inter, Itaú, Bradesco, Santander, C6 Bank, Mercado Pago, Picpay, Caixa, Banco do Brasil.`);
      return;
    }

    // Verifica limite de contas
    const { count } = await supabase.from('wallets')
      .select('*', { count: 'exact', head: true }).eq('grupo_id', grupoId);

    const jaExiste = await supabase.from('wallets')
      .select('id').eq('grupo_id', grupoId).ilike('nome', nomeFinal).single();

    if (!jaExiste.data && count >= limitePorPlano(user.plano)) {
      await enviarTexto(phone, `⚠️ Limite de ${limitePorPlano(user.plano)} contas atingido no seu plano.\nRemova uma conta antes de adicionar outra, ou faça upgrade.`);
      return;
    }

    const ehCredito = nomeFinal.includes('Crédito');
    // Tipo vindo da IA (Corrente/Poupança/Vale Alimentação/Dinheiro) ou
    // default conforme o nome.
    let tipo = data.tipo;
    if (!tipo || !TIPOS_CONTA.includes(tipo)) {
      if (ehCredito) tipo = 'Crédito';
      else if (/dinheiro|carteira/i.test(nomeFinal)) tipo = 'Dinheiro';
      else tipo = 'Corrente';
    }

    const { data: walletCriada } = await supabase.from('wallets').upsert({
      grupo_id: grupoId,
      nome:     nomeFinal,
      tipo,
      saldo:    parseFloat(data.valor)
    }, { onConflict: 'grupo_id,nome' }).select().single();
    // Dono da conta (só na criação) — tolerante se a migration 049 não rodou.
    if (walletCriada?.id && !walletCriada.criado_por && user?.id) {
      await supabase.from('wallets').update({ criado_por: user.id }).eq('id', walletCriada.id);
    }

    const emojiTipo = tipo === 'Poupança' ? '🐷'
                    : tipo === 'Vale Alimentação' ? '🍔'
                    : tipo === 'Dinheiro' ? '💵'
                    : tipo === 'Crédito' ? '💳'
                    : '🏦';

    await enviarTexto(phone,
      `${emojiTipo} Conta *${nomeFinal}* (${tipo}) criada com saldo de R$ ${parseFloat(data.valor).toFixed(2)}.`
    );

    // Se foi criada como Corrente (default) e o usuário não especificou,
    // oferece chance de mudar o tipo na próxima mensagem.
    const tipoVeioDoUsuario = !!data.tipo && TIPOS_CONTA.includes(data.tipo);
    if (!tipoVeioDoUsuario && tipo === 'Corrente' && user?.id && walletCriada) {
      await enviarTexto(phone,
        `💡 É conta corrente mesmo? Se for *poupança*, *vale alimentação* ou *dinheiro*, é só responder com o tipo.`
      );
      await criarPendente({
        userId: user.id,
        tipoPergunta: 'tipo_conta',
        contexto: { wallet_id: walletCriada.id, wallet_nome: nomeFinal },
      });
    }

    return;
  }

  // ── CRIAR / DEFINIR CARTÃO DE CRÉDITO ───────────────────────────
  if (data.acao === 'set_cartao') {
    const nomeFinal = normalizarBanco(data.nome);
    if (!nomeFinal) {
      await enviarTexto(phone,
        `⚠️ *"${data.nome}"* não é um banco reconhecido.\nUse: Nubank, Inter, Itaú, Bradesco, Santander, C6 Bank, Mercado Pago, Picpay, Caixa, Banco do Brasil.`);
      return;
    }
    const nomeCartao = nomeFinal.includes('Crédito') ? nomeFinal : `${nomeFinal} Crédito`;

    // Verifica limite do plano
    const { count } = await supabase.from('wallets')
      .select('*', { count: 'exact', head: true }).eq('grupo_id', grupoId);
    const jaExiste = await supabase.from('wallets')
      .select('id').eq('grupo_id', grupoId).ilike('nome', nomeCartao).single();
    if (!jaExiste.data && count >= limitePorPlano(user.plano)) {
      await enviarTexto(phone, `⚠️ Limite de ${limitePorPlano(user.plano)} contas atingido.`);
      return;
    }

    // Cria com dados parciais (saldo = 0 pra cartão, limite vem como metadata)
    const { data: walletCartao } = await supabase.from('wallets').upsert({
      grupo_id: grupoId,
      nome:     nomeCartao,
      tipo:     'Crédito',
      saldo:    0,
      limite:        data.limite || null,
      dia_fechamento: data.dia_fechamento || null,
      dia_vencimento: data.dia_vencimento || null,
      bandeira:      data.bandeira && BANDEIRAS.includes(data.bandeira) ? data.bandeira : null,
    }, { onConflict: 'grupo_id,nome' }).select().single();
    if (walletCartao?.id && !walletCartao.criado_por && user?.id) {
      await supabase.from('wallets').update({ criado_por: user.id }).eq('id', walletCartao.id);
    }

    // Verifica quais campos faltam pra iniciar o wizard
    const faltam = [];
    if (!data.limite)         faltam.push('limite');
    if (!data.dia_fechamento) faltam.push('dia_fechamento');
    if (!data.dia_vencimento) faltam.push('dia_vencimento');
    if (!data.bandeira)       faltam.push('bandeira');

    if (faltam.length === 0) {
      await enviarTexto(phone,
        `💳 *Cartão criado!*\n\n` +
        `🏦 ${nomeCartao}\n` +
        `💳 Bandeira: ${data.bandeira}\n` +
        `💰 Limite: R$ ${data.limite.toFixed(2)}\n` +
        `📅 Fecha dia ${data.dia_fechamento} · Vence dia ${data.dia_vencimento}`
      );
      return;
    }

    // Inicia wizard pra preencher o que falta
    const proximoCampo = faltam[0];
    const perguntas = {
      limite:         '💰 Qual o *limite total* do cartão?',
      dia_fechamento: '📅 Em qual *dia fecha a fatura*? (1 a 28)',
      dia_vencimento: '📅 E qual *dia vence*? (1 a 28)',
      bandeira:       '💳 Qual a *bandeira*?\n1️⃣ Visa  2️⃣ Mastercard  3️⃣ Elo  4️⃣ Amex  5️⃣ Hipercard\nOu responda *pular* se não quiser informar.',
    };

    await enviarTexto(phone,
      `💳 *${nomeCartao}* registrado!\n\n` +
      `Pra eu gerenciar a fatura direito, preciso de mais alguns dados.\n\n${perguntas[proximoCampo]}`
    );

    if (user?.id && walletCartao) {
      await criarPendente({
        userId: user.id,
        tipoPergunta: 'criar_cartao',
        contexto: {
          wallet_id: walletCartao.id,
          wallet_nome: nomeCartao,
          faltam,           // ordem dos campos a preencher
          campo_atual: proximoCampo,
        },
      });
    }
    return;
  }

  // ── ADICIONAR SALDO ─────────────────────────────────────────────
  if (data.acao === 'adicionar_saldo') {
    const nomeFinal = normalizarBanco(data.nome);
    if (!nomeFinal) {
      await enviarTexto(phone, `⚠️ Banco *"${data.nome}"* não reconhecido.`);
      return;
    }

    const { data: wallet } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', nomeFinal).single();

    if (!wallet) {
      await enviarTexto(phone, `❌ Conta *${nomeFinal}* não encontrada. Crie primeiro com "${nomeFinal.toLowerCase()} 0".`);
      return;
    }

    const novoSaldo = wallet.saldo + parseFloat(data.valor);
    await supabase.from('wallets').update({ saldo: novoSaldo }).eq('id', wallet.id);
    await enviarTexto(phone, `✅ R$ ${parseFloat(data.valor).toFixed(2)} adicionados à conta *${nomeFinal}*.\nNovo saldo: R$ ${novoSaldo.toFixed(2)}`);
    return;
  }

  // ── ALTERAR SALDO ───────────────────────────────────────────────
  if (data.acao === 'alterar_saldo') {
    const nomeFinal = normalizarBanco(data.nome);
    if (!nomeFinal) {
      await enviarTexto(phone, `⚠️ Banco *"${data.nome}"* não reconhecido.`);
      return;
    }

    const { data: wallet } = await supabase.from('wallets')
      .select('id').eq('grupo_id', grupoId).ilike('nome', nomeFinal).single();

    if (!wallet) {
      await enviarTexto(phone, `❌ Conta *${nomeFinal}* não encontrada.`);
      return;
    }

    await supabase.from('wallets').update({ saldo: parseFloat(data.valor) }).eq('id', wallet.id);
    await enviarTexto(phone, `✅ Saldo da conta *${nomeFinal}* atualizado para R$ ${parseFloat(data.valor).toFixed(2)}.`);
    return;
  }

  // ── VER SALDOS ──────────────────────────────────────────────────
  if (data.acao === 'ver_saldos') {
    const { data: wallets } = await supabase.from('wallets')
      .select('nome, saldo, tipo').eq('grupo_id', grupoId).order('nome');

    if (!wallets?.length) {
      await enviarTexto(phone, '🏦 Nenhuma conta cadastrada.\nCrie com: "nubank 1000"');
      return;
    }

    const linhas = wallets.map(w => {
      const emoji = w.tipo === 'Crédito' ? '💳' : w.tipo === 'Poupança' ? '🐷' : w.tipo === 'Dinheiro' ? '💵' : '🏦';
      return `${emoji} *${w.nome}:* R$ ${w.saldo.toFixed(2)}`;
    }).join('\n');

    const emContas  = wallets.filter(w => w.tipo !== 'Crédito').reduce((s, w) => s + (w.saldo || 0), 0);
    const saldoCard = wallets.filter(w => w.tipo === 'Crédito').reduce((s, w) => s + (w.saldo || 0), 0); // negativo = a pagar
    const aPagar    = saldoCard < 0 ? -saldoCard : 0;

    // Com cartão a pagar, mostra o líquido (contas − fatura). Sem cartão, só o total.
    const rodape = aPagar > 0
      ? `💵 Total em contas: R$ ${emContas.toFixed(2)}\n` +
        `💳 A pagar no cartão: R$ ${aPagar.toFixed(2)}\n` +
        `💰 *Saldo líquido: R$ ${(emContas + saldoCard).toFixed(2)}*`
      : `💵 *Total: R$ ${emContas.toFixed(2)}*`;

    await enviarTexto(phone, `💰 *SEUS SALDOS:*\n\n${linhas}\n\n${rodape}`);
    return;
  }

  // ── TRANSFERIR ──────────────────────────────────────────────────
  if (data.acao === 'transferir') {
    const nomeOrigem  = normalizarBanco(data.origem);
    const nomeDestino = normalizarBanco(data.destino);
    const valor       = parseFloat(data.valor);

    if (!nomeOrigem || !nomeDestino) {
      await enviarTexto(phone, '⚠️ Banco de origem ou destino não reconhecido.');
      return;
    }

    const { data: origem } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', nomeOrigem).single();

    if (!origem) {
      await enviarTexto(phone, `❌ Conta *${nomeOrigem}* não encontrada.`);
      return;
    }
    if (origem.saldo < valor) {
      await enviarTexto(phone, `⚠️ Saldo insuficiente em *${nomeOrigem}*. Disponível: R$ ${origem.saldo.toFixed(2)}`);
      return;
    }

    // Debita origem
    await supabase.from('wallets').update({ saldo: origem.saldo - valor }).eq('id', origem.id);

    // Credita destino (cria se não existir)
    const { data: destino } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', nomeDestino).single();

    if (destino) {
      await supabase.from('wallets').update({ saldo: destino.saldo + valor }).eq('id', destino.id);
    } else {
      const { data: novoDest } = await supabase.from('wallets').insert({
        grupo_id: grupoId, nome: nomeDestino,
        tipo: nomeDestino.includes('Crédito') ? 'Crédito' : 'Corrente',
        saldo: valor
      }).select('id').single();
      if (novoDest?.id && user?.id) {
        await supabase.from('wallets').update({ criado_por: user.id }).eq('id', novoDest.id);
      }
    }

    // Grava no histórico (transferencia=true → fora dos relatórios de gasto).
    const { registrarTransferencia } = require('../services/contaDebito');
    await registrarTransferencia({ grupoId, origemNome: nomeOrigem, destinoNome: nomeDestino, valor })
      .catch(() => {});

    await enviarTexto(phone,
      `💸 *Transferência realizada!*\n\n` +
      `📤 Saída: *${nomeOrigem}*\n` +
      `📥 Entrada: *${nomeDestino}*\n` +
      `💵 Valor: R$ ${valor.toFixed(2)}`
    );
    return;
  }

  // ── DELETAR CONTA ───────────────────────────────────────────────
  if (data.acao === 'deletar_conta') {
    const nomeFinal = normalizarBanco(data.nome) || data.nome;

    const { data: wallet } = await supabase.from('wallets')
      .select('id, nome').eq('grupo_id', grupoId).ilike('nome', nomeFinal).single();

    if (!wallet) {
      await enviarTexto(phone, `❌ Conta *${nomeFinal}* não encontrada.`);
      return;
    }

    await supabase.from('wallets').delete().eq('id', wallet.id);
    await enviarTexto(phone, `🗑️ Conta *${wallet.nome}* removida com sucesso.`);
    return;
  }

  // ── GASTOS POR CARTÃO / CONTA ───────────────────────────────────
  // "gastos dos meus cartões", "quanto gastei nas contas", "gastos por cartão".
  // Cartões pela FATURA ABERTA (ciclo de fechamento); contas pelo gasto do MÊS.
  if (data.acao === 'gastos_carteiras') {
    const { data: wallets } = await supabase.from('wallets')
      .select('nome, tipo, limite, dia_fechamento').eq('grupo_id', grupoId).order('nome');

    if (!wallets?.length) {
      await enviarTexto(phone,
        '🏦 Você ainda não tem contas nem cartões cadastrados.\n' +
        'Crie com: *nubank 1000* ou *cartão nubank limite 5000 fecha 5 vence 15*.');
      return;
    }

    const { cicloFatura } = require('./parcelas');
    const [Y, M] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).split('-').map(Number);
    const iniMes = new Date(Date.UTC(Y, M - 1, 1, 12)).toISOString().slice(0, 10);
    const fimMes = new Date(Date.UTC(Y, M, 1, 12)).toISOString().slice(0, 10);

    const cartoes = [], contas = [];
    for (const w of wallets) {
      if (w.tipo === 'Crédito') {
        const c = w.dia_fechamento ? cicloFatura(w.dia_fechamento, 0) : { ini: iniMes, fimExcl: fimMes };
        const fatura = await somarGastosCarteira(grupoId, w.nome, c.ini, c.fimExcl);
        cartoes.push({ nome: w.nome, fatura, limite: w.limite });
      } else {
        const gasto = await somarGastosCarteira(grupoId, w.nome, iniMes, fimMes, true);
        contas.push({ nome: w.nome, gasto, tipo: w.tipo });
      }
    }

    const mesNome = new Date(Date.UTC(Y, M - 1, 1)).toLocaleDateString('pt-BR', { month: 'long' });
    let msg = `💸 *Gastos por cartão e conta* · ${mesNome}`;

    if (cartoes.length) {
      msg += `\n\n*💳 Cartões (fatura aberta):*\n` + cartoes.map(c => {
        const uso = c.limite ? ` · ${Math.round((c.fatura / c.limite) * 100)}% do limite` : '';
        return `💳 *${c.nome}:* R$ ${c.fatura.toFixed(2)}${uso}`;
      }).join('\n');
    }
    if (contas.length) {
      msg += `\n\n*🏦 Contas (gasto no mês):*\n` + contas.map(c => {
        const emoji = c.tipo === 'Poupança' ? '🐷' : c.tipo === 'Dinheiro' ? '💵' : '🏦';
        return `${emoji} *${c.nome}:* R$ ${c.gasto.toFixed(2)}`;
      }).join('\n');
    }

    const total = cartoes.reduce((s, c) => s + c.fatura, 0) + contas.reduce((s, c) => s + c.gasto, 0);
    msg += `\n\n💰 *Total: R$ ${total.toFixed(2)}*`;

    await enviarBotaoLink(phone, { message: msg, label: 'Ver no painel', url: 'https://forsora.com/dashboard' });
    return;
  }
};