const supabase = require('../db/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// "Essa carteira existe? Se não, cria."
//
// ⚠️ POR QUE ISTO EXISTE: `transacoes.carteira_nome` é TEXTO, não FK. Nada no
// banco impede gravar o nome de uma carteira que não existe — e quando isso
// acontece a transação vira ÓRFÃ: continua no banco, mas não pertence a conta
// nenhuma. Não mexe em saldo, não aparece no extrato da conta e some de
// qualquer filtro por conta. Pro usuário é "o lançamento não sincronizou".
//
// Medido em 02/09/2026, antes deste helper: 20 transações órfãs em 9 grupos.
// O nome fantasma mais comum era justamente **"Dinheiro"** — o fallback que o
// próprio código escreve quando não sabe de que conta saiu. Ele era gravado por
// caminhos que nunca criavam a carteira correspondente (o cron de recorrências
// era o principal).
//
// A comparação é NORMALIZADA (sem acento, sem caixa) porque o resto do sistema
// casa transação com carteira por `ilike` — "Mercado pago" e "mercado Pago" são
// a mesma conta, e criar a segunda produziria conta duplicada em vez de resolver.
// ─────────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function tipoPeloNome(nome) {
  if (/cr[ée]dito/i.test(nome)) return 'Crédito';
  if (/carteira|dinheiro|cash|esp[ée]cie/i.test(nome)) return 'Dinheiro';
  if (/poupan/i.test(nome)) return 'Poupança';
  if (/(vale|alelo|sodexo|ticket|refei)/i.test(nome)) return 'Vale Alimentação';
  return 'Corrente';
}

/**
 * Garante que existe uma carteira com esse nome no grupo.
 *
 * @returns {Promise<string|null>} o nome REAL da carteira (o já existente, se
 *   houver um equivalente), ou `null` se não deu pra garantir — e aí quem chama
 *   NÃO deve gravar o nome, senão cria a órfã que este helper existe pra evitar.
 */
async function garantirCarteira(grupoId, nome, saldoInicial = 0) {
  if (!grupoId || !nome) return null;

  const { data: existentes, error } = await supabase
    .from('wallets').select('id, nome').eq('grupo_id', grupoId);

  // ⚠️ Falha de LEITURA não pode virar carteira nova: se a consulta caiu, eu não
  // sei se ela existe, e criar às cegas duplicaria a conta do usuário. Devolvo o
  // nome como veio — é o comportamento de antes, sem piorar nada.
  if (error) return nome;

  const igual = (existentes || []).find((w) => norm(w.nome) === norm(nome));
  if (igual) return igual.nome;

  const { error: eCria } = await supabase.from('wallets').upsert({
    grupo_id: grupoId,
    nome,
    tipo: tipoPeloNome(nome),
    saldo: saldoInicial,
  }, { onConflict: 'grupo_id,nome' });

  if (eCria) {
    console.error('[garantirCarteira] não criei "%s" no grupo %s: %s', nome, grupoId, eCria.message);
    return null;
  }
  return nome;
}

module.exports = { garantirCarteira, tipoPeloNome };
