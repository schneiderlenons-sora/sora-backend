const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');

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
    await supabase.from('wallets').upsert({
      grupo_id: grupoId,
      nome:     nomeFinal,
      tipo:     ehCredito ? 'Crédito' : 'Corrente',
      saldo:    parseFloat(data.valor)
    }, { onConflict: 'grupo_id,nome' });

    await enviarTexto(phone, `🏦 Conta *${nomeFinal}* configurada com saldo de R$ ${parseFloat(data.valor).toFixed(2)}.`);
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
      const emoji = w.tipo === 'Crédito' ? '💳' : w.tipo === 'Poupança' ? '🐷' : '🏦';
      return `${emoji} *${w.nome}:* R$ ${w.saldo.toFixed(2)}`;
    }).join('\n');

    const total = wallets
      .filter(w => w.tipo !== 'Crédito')
      .reduce((s, w) => s + w.saldo, 0);

    await enviarTexto(phone, `💰 *SEUS SALDOS:*\n\n${linhas}\n\n💵 *Total (sem crédito): R$ ${total.toFixed(2)}*`);
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
      await supabase.from('wallets').insert({
        grupo_id: grupoId, nome: nomeDestino,
        tipo: nomeDestino.includes('Crédito') ? 'Crédito' : 'Corrente',
        saldo: valor
      });
    }

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
};