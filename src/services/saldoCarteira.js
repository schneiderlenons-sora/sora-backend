// =============================================================================
// Mexer no saldo de uma carteira — a REGRA DE OURO num lugar só.
//
// ⚠️ CONTA DO OPEN FINANCE NUNCA TEM SALDO AJUSTADO À MÃO. O saldo dela é o que
// o banco informa, e o sync o reescreve a cada rodada: somar aqui só faz o
// número andar e VOLTAR sozinho horas depois.
//
// POR QUE EXISTE (set/2026): um cliente mandou vídeo dizendo que "a Sora não
// sincroniza" — lançava pelo app e o saldo da conta não mudava. A conta era do
// Open Finance, e o painel estava CERTO em não mexer. Mas o WhatsApp mexia (5
// arquivos, sem nenhuma trava): o mesmo lançamento mudava o saldo por um canal
// e não pelo outro, e o do zap ainda voltava sozinho no sync seguinte.
//
// Quem mexe em saldo pelo WhatsApp passa por aqui. `of_conta_id` no objeto evita
// uma leitura; ausente (`undefined`), a função lê. Falha de leitura mantém o
// comportamento de antes (mexe) — é o caso raro, e o sync corrige.
// =============================================================================
const supabase = require('../db/supabase');

async function ehDoBanco(wallet) {
  if (!wallet || !wallet.id) return false;
  if (wallet.of_conta_id !== undefined) return !!wallet.of_conta_id;
  const { data } = await supabase.from('wallets').select('of_conta_id').eq('id', wallet.id).maybeSingle();
  return !!(data && data.of_conta_id);
}

/** Soma `delta` (na moeda da conta) ao saldo. `false` = conta do banco, nada mudou. */
async function moverSaldo(wallet, delta) {
  if (!wallet || !wallet.id) return false;
  if (await ehDoBanco(wallet)) return false;
  await supabase.from('wallets')
    .update({ saldo: (Number(wallet.saldo) || 0) + (Number(delta) || 0) }).eq('id', wallet.id);
  return true;
}

/** Grava um saldo ABSOLUTO (desfazer um estorno que não pôde ser concluído). */
async function gravarSaldo(wallet, saldo) {
  if (!wallet || !wallet.id) return false;
  if (await ehDoBanco(wallet)) return false;
  await supabase.from('wallets').update({ saldo }).eq('id', wallet.id);
  return true;
}

// Linha que o WhatsApp acrescenta quando o lançamento caiu numa conta do banco:
// explica por que o saldo não mudou E previne a duplicata (o banco vai trazer a
// mesma movimentação).
const avisoContaDoBanco = (nome) =>
  `🏦 *${nome}* está conectada ao seu banco: o saldo vem de lá e muda quando o banco atualizar. ` +
  'Essa movimentação também deve chegar sozinha — se aparecer repetida, é só apagar esta.';

module.exports = { ehDoBanco, moverSaldo, gravarSaldo, avisoContaDoBanco };
