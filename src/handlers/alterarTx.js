// =============================================================================
// ALTERAR UMA TRANSAÇÃO PELO WHATSAPP
//
// Pedido de cliente (Fábio, 05/10/2026): *"a possibilidade de ALTERAR o
// lançamento, e não só a de exclusão"*. Antes a única saída era apagar e
// lançar de novo — o que troca o id, perde a data original e, se a pessoa
// esquecer de relançar, some com o gasto.
//
// ⚠️ A ARITMÉTICA DO SALDO NÃO MORA AQUI. Ela está em
// `services/alterarTransacao.js`, compartilhada com o `PUT` do painel. Este
// arquivo só orquestra: acha a linha, resolve a conta, grava e conta o que
// mudou.
// =============================================================================

const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');
const { moverSaldo } = require('../services/saldoCarteira');
const { garantirCarteira } = require('../services/carteiraGarantida');
const { formatadorDoGrupo, formatar } = require('../services/moeda');
const { planoDeAlteracao, ajustesDeSaldo, ROTULO } = require('../services/alterarTransacao');

/** Data `YYYY-MM-DD` → `DD/MM`. */
function dataCurta(v) {
  const s = String(v || '').slice(0, 10);
  const [a, m, d] = s.split('-');
  return d ? `${d}/${m}` : s;
}

/**
 * Como mostrar o valor de um campo na confirmação.
 *
 * ⚠️ O VALOR SAI NA MOEDA DA CONTA, não na base do grupo: é o número que a
 * pessoa falou e o que ela vê no extrato daquela conta.
 */
function mostrar(campo, tx, fmt) {
  switch (campo) {
    case 'valor':
      // ⚠️ EM CONTA ESTRANGEIRA MOSTRA AS DUAS: o nativo e o que a pessoa
      // falou e ve no extrato daquela conta; o da base e o que entra nas somas
      // do painel. Mostrar so um dos dois faz o lancamento CERTO parecer
      // errado — mesma razao da confirmacao de "salvar".
      if (tx.moeda && tx.valor_moeda != null) {
        return formatar(tx.valor_moeda, tx.moeda) + ' (' + fmt(tx.valor) + ')';
      }
      return fmt(tx.valor);
    case 'categoria': return tx.categoria || '—';
    case 'descricao': return tx.observacao || '—';
    case 'conta':     return tx.carteira_nome || '—';
    case 'data':      return dataCurta(tx.data);
    case 'tipo':      return tx.tipo;
    default:          return '—';
  }
}

/**
 * Resolve a conta citada contra as carteiras REAIS do grupo.
 *
 * ⚠️ Reusa o `resolverCarteiraReal` do handler de transações (exato → sem
 * ruído → palavra → fuzzy). Escrever outro casamento aqui recriaria a
 * conta-fantasma que o projeto já fechou em três portas.
 */
async function contaReal(grupoId, nome, resolver) {
  const achada = await resolver(grupoId, nome);
  return achada || null;
}

/**
 * @param {Object} p
 * @param {string} p.phone
 * @param {string} p.grupoId
 * @param {Object} p.data        o que o interpretador devolveu
 * @param {Function} p.resolverCarteiraReal
 */
async function alterarTx({ phone, grupoId, data, resolverCarteiraReal }) {
  const fmt = await formatadorDoGrupo(grupoId);

  // ── 1. ACHAR A LINHA ──────────────────────────────────────────────────────
  let q = supabase.from('transacoes').select('*').eq('grupo_id', grupoId);
  if (data.idCurto) q = q.eq('id_curto', data.idCurto);
  else q = q.order('created_at', { ascending: false }).limit(1);

  const { data: rows, error: erroLer } = await q;
  if (erroLer) {
    // ⚠️ Falha de LEITURA não vira "não achei": a linha pode existir, e dizer
    // que não existe convida a pessoa a lançar de novo — duplicando o gasto.
    console.error('[alterarTx] falha ao ler:', erroLer.message);
    await enviarTexto(phone, '❌ Não consegui consultar agora. Tenta de novo em instantes.');
    return;
  }

  const tx = rows?.[0];
  if (!tx) {
    await enviarTexto(phone, data.idCurto
      ? `❌ Não achei a transação *${data.idCurto}*.\n\nO código aparece na confirmação de cada lançamento (🔑 ID).`
      : '❌ Não achei nenhuma transação pra alterar.');
    return;
  }

  // ── 2. SEM CAMPO CITADO: mostra o que dá pra mudar ────────────────────────
  //
  // ⚠️ NÃO é erro — a intenção está clara, só falta o quê. Responder "não
  // entendi" faria a pessoa desistir; aqui ela vê o estado atual e o formato.
  const pedidas = Object.keys(data.mudancas || {});
  if (!pedidas.length) {
    await enviarTexto(phone,
      `✏️ *Transação ${tx.id_curto}*\n\n` +
      `💸 Valor: ${mostrar('valor', tx, fmt)}\n` +
      `🏷️ Categoria: ${tx.categoria}\n` +
      `📝 Descrição: ${tx.observacao || '—'}\n` +
      `🏦 Conta: ${tx.carteira_nome}\n` +
      `📅 Data: ${dataCurta(tx.data)}\n\n` +
      `O que você quer mudar? Responde assim:\n` +
      `• *altera ${tx.id_curto} para 50*\n` +
      `• *altera ${tx.id_curto} categoria Mercado*\n` +
      `• *altera ${tx.id_curto} descrição Feira da semana*\n` +
      `• *altera ${tx.id_curto} conta Nubank*\n` +
      `• *altera ${tx.id_curto} data 05/10*`
    );
    return;
  }

  // ── 3. A CONTA CITADA PRECISA SER REAL ────────────────────────────────────
  const mudancas = { ...data.mudancas };
  if (mudancas.conta) {
    const real = await contaReal(grupoId, mudancas.conta, resolverCarteiraReal);
    if (!real) {
      // ⚠️ PERGUNTA EM VEZ DE CRIAR. Criar a conta aqui, a partir de um nome
      // digitado torto, é como nascem as contas duplicadas ("Nubnak").
      const { data: contas } = await supabase.from('wallets')
        .select('nome').eq('grupo_id', grupoId).order('nome');
      const lista = (contas || []).map((c) => `• ${c.nome}`).join('\n');
      await enviarTexto(phone,
        `🤔 Não achei a conta *${mudancas.conta}* entre as suas.\n\n` +
        (lista ? `Suas contas:\n${lista}\n\n` : '') +
        `Manda de novo com o nome exato.`);
      return;
    }
    mudancas.conta = real;
  }

  // ── 4. O PLANO ────────────────────────────────────────────────────────────
  const { patch, depois, alterados } = planoDeAlteracao(tx, mudancas);
  if (!alterados.length) {
    await enviarTexto(phone, `ℹ️ A transação *${tx.id_curto}* já está assim — não mudei nada.`);
    return;
  }

  // ⚠️ A CARTEIRA DE DESTINO TEM DE EXISTIR ANTES DE A LINHA APONTAR PRA ELA.
  // `transacoes.carteira_nome` é TEXTO, não FK: gravar um nome que não é
  // carteira de ninguém cria a conta-fantasma — a linha some de todo filtro
  // por conta e não mexe em saldo. Aqui ela sempre existe (passou pelo
  // `resolverCarteiraReal`), mas o helper é a porta única do projeto.
  if (patch.carteira_nome) {
    // Devolve o nome CANONICO da carteira (a grafia que o banco ja tem), ou
    // null se nao deu pra garantir.
    const nomeCanonico = await garantirCarteira(grupoId, patch.carteira_nome);
    if (!nomeCanonico) {
      console.error('[alterarTx] não garanti a carteira', patch.carteira_nome);
      await enviarTexto(phone, `❌ Não consegui mover pra *${patch.carteira_nome}* agora. A transação continua em *${tx.carteira_nome}*.`);
      return;
    }
    patch.carteira_nome = nomeCanonico;
    depois.carteira_nome = nomeCanonico;
  }

  // ── 5. GRAVA ──────────────────────────────────────────────────────────────
  const { data: txNova, error } = await supabase.from('transacoes')
    .update(patch).eq('id', tx.id).eq('grupo_id', grupoId).select().single();

  // ⚠️ O ERRO É LIDO. A família de bugs mais cara deste projeto é
  // `const { data } = await ...` sem checar `error`: a gravação falha, a
  // resposta diz que deu certo, e o cliente só descobre dias depois.
  if (error || !txNova) {
    console.error('[alterarTx] update falhou:', error?.message);
    await enviarTexto(phone, '❌ Não consegui salvar a alteração. Nada foi mudado — tenta de novo.');
    return;
  }

  // ── 6. SALDO ──────────────────────────────────────────────────────────────
  //
  // ⚠️ DEPOIS da gravação, e tolerante: se o saldo falhar, a transação já está
  // certa e a pessoa vê a correção. O contrário (mexer no saldo e a linha não
  // gravar) deixaria o saldo errado sem nada que explique.
  try {
    const { ajustes } = ajustesDeSaldo(tx, depois);
    for (const { nome, delta } of ajustes) {
      const { data: w } = await supabase.from('wallets')
        .select('id, saldo, of_conta_id').eq('grupo_id', grupoId).ilike('nome', nome).maybeSingle();
      // `moverSaldo` é a porta única: ela pula carteira de Open Finance, onde
      // o saldo é do banco (regra de ouro).
      if (w) await moverSaldo(w, delta);
    }
  } catch (e) {
    console.warn('[alterarTx] ajuste de saldo falhou:', e.message);
  }

  // ── 7. CONFIRMA DIZENDO O QUE MUDOU ───────────────────────────────────────
  //
  // ⚠️ MOSTRA O DE → PARA. "Alterado!" sozinho obriga a pessoa a abrir o
  // painel pra conferir — e é justamente a conferência que ela quer evitar.
  const linhas = alterados.map((c) =>
    `${ROTULO[c]}: ~${mostrar(c, tx, fmt)}~ → *${mostrar(c, txNova, fmt)}*`);

  await enviarTexto(phone,
    `✅ *Transação ${tx.id_curto} alterada!*\n\n` +
    `${linhas.join('\n')}\n\n` +
    `📝 ${txNova.observacao || txNova.categoria} · 🏦 ${txNova.carteira_nome}`
  );
}

module.exports = { alterarTx, dataCurta, mostrar };
