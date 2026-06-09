// =============================================================================
// oferecerDesconto — após um aporte/pagamento pelo WhatsApp (meta, investimento,
// dívida, fatura), pergunta se o usuário quer descontar de uma conta e lista as
// contas (não-crédito). A resposta é resolvida pelo pendente 'descontar_destino'
// (handlers/pendentes.js), que chama debitarConta.
//
// Se não houver conta cadastrada, não pergunta nada.
// =============================================================================
const supabase = require('../db/supabase');
const { enviarTexto } = require('./zapi');
const { criarPendente } = require('./pendentes');

const fmt = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

async function oferecerDesconto({ user, phone, grupoId, valor, categoria, observacao, intro }) {
  if (!user?.id || !grupoId || !valor) return;

  const { data: contas } = await supabase.from('wallets')
    .select('id, nome, saldo, tipo').eq('grupo_id', grupoId).order('nome');
  const opcoes = (contas || [])
    .filter(c => c.tipo !== 'Crédito')
    .map(c => ({ id: c.id, nome: c.nome, saldo: c.saldo }));
  if (!opcoes.length) return;

  await criarPendente({
    userId: user.id,
    tipoPergunta: 'descontar_destino',
    contexto: { valor, categoria, observacao, opcoes },
    expiresInMin: 15,
  });

  const cabecalho = intro || '💳 Quer *descontar de uma conta*?';
  const lista = opcoes.map((o, i) => `${i + 1}. ${o.nome} — ${fmt(o.saldo)}`).join('\n');
  await enviarTexto(phone,
    `${cabecalho}\n\n${lista}\n\nResponda o *número* da conta, ou *não*.`);
}

module.exports = { oferecerDesconto };
