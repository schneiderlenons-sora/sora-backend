// =============================================================================
// oferecerDesconto — após um aporte/pagamento pelo WhatsApp (meta, investimento,
// dívida, fatura), pergunta se o usuário quer descontar de uma conta e lista as
// contas (não-crédito). A resposta é resolvida pelo pendente 'descontar_destino'
// (handlers/pendentes.js), que chama debitarConta.
//
// Se não houver conta cadastrada, não pergunta nada.
// =============================================================================
const supabase = require('../db/supabase');
const { enviarTexto } = require('./mensageiro');
const { criarPendente } = require('./pendentes');

const fmt = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

// Retorna `true` se realmente perguntou (quem chama pode dar outro aviso se
// não houver conta pra oferecer — é o que o cron de fatura faz).
async function oferecerDesconto({ user, phone, grupoId, valor, categoria, observacao, intro, extra, permiteExterno, expiresInMin }) {
  if (!user?.id || !grupoId || !valor) return false;

  const { data: contas } = await supabase.from('wallets')
    .select('id, nome, saldo, tipo').eq('grupo_id', grupoId).order('nome');
  const opcoes = (contas || [])
    .filter(c => c.tipo !== 'Crédito')
    .map(c => ({ id: c.id, nome: c.nome, saldo: c.saldo }));
  // Sem conta nenhuma: só segue se dá pra registrar "pago por outra pessoa"
  // (ex.: fatura). Senão não há o que perguntar.
  if (!opcoes.length && !permiteExterno) return false;

  await criarPendente({
    userId: user.id,
    tipoPergunta: 'descontar_destino',
    // `extra` (ex.: cartao_id + competencia da fatura) segue no contexto pra o
    // pendente registrar pagamentos_fatura ao debitar. `permiteExterno` habilita
    // a opção "pago por outra pessoa" (não desconta de conta).
    contexto: { valor, categoria, observacao, opcoes, permiteExterno: !!permiteExterno, ...(extra || {}) },
    // Padrão 15min; o aviso proativo de fatura pede dias (não pode expirar antes
    // do usuário ver a mensagem).
    expiresInMin: expiresInMin || 15,
  });

  const cabecalho = intro || '💳 Quer *descontar de uma conta*?';
  const linhas = opcoes.map((o, i) => `${i + 1}. ${o.nome} — ${fmt(o.saldo)}`);
  if (permiteExterno) linhas.push(`${opcoes.length + 1}. 👤 Pago por outra pessoa (não desconta)`);
  await enviarTexto(phone,
    `${cabecalho}\n\n${linhas.join('\n')}\n\nResponda o *número*, ou *não*.`);
  return true;
}

module.exports = { oferecerDesconto };
