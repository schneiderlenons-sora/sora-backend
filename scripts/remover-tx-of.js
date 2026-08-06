// =============================================================================
// Remove transações importadas do Open Finance, de forma DEFINITIVA.
//
// ⚠️ Registra o `of_tx_id` em `of_tx_ignoradas` (migration 113) ANTES de
// apagar. Sem esse registro a exclusão não gruda: o sync deduplica olhando a
// tabela `transacoes`, não acha a linha apagada e reimporta como nova no dia
// seguinte. Por isso o script RECUSA rodar se a migration não tiver rodado —
// apagar sem registrar é trabalho perdido e o usuário acha que a Sora ignorou.
//
// Uso:
//   node scripts/remover-tx-of.js --ids=<uuid>,<uuid>            # simulação
//   node scripts/remover-tx-of.js --ids=<uuid>,<uuid> --apply
// =============================================================================
require('dotenv').config();
const supabase = require('../src/db/supabase');

const APLICAR = process.argv.includes('--apply');
const IDS = ((process.argv.find((a) => a.startsWith('--ids=')) || '').split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const brl = (v) => `R$ ${Number(v).toFixed(2)}`;

(async () => {
  if (!IDS.length) { console.error('Informe --ids=<uuid>,<uuid>'); process.exit(1); }
  console.log(APLICAR ? '⚠️  MODO GRAVAÇÃO' : '🔍 SIMULAÇÃO (nada será apagado)', '\n');

  // A trava: sem a tabela, a exclusão seria desfeita pelo próximo sync.
  const { error: eTab } = await supabase.from('of_tx_ignoradas').select('id').limit(1);
  if (eTab) {
    console.error('✗ Tabela `of_tx_ignoradas` não existe — rode a migration 113 antes.');
    console.error('  Sem ela, apagar não adianta: o sync reimporta no dia seguinte.');
    process.exit(1);
  }

  const { data: alvos, error } = await supabase.from('transacoes')
    .select('id, grupo_id, data, observacao, valor, tipo, pago, carteira_nome, of_tx_id')
    .in('id', IDS);
  if (error) { console.error('erro lendo transacoes:', error.message); process.exit(1); }

  console.log('pedidas:', IDS.length, '· encontradas:', alvos.length, '\n');
  for (const t of alvos) {
    console.log([
      String(t.data).slice(0, 10), brl(t.valor).padStart(11), String(t.tipo).padEnd(12),
      'pago:' + String(t.pago).padEnd(5), (t.carteira_nome || '').slice(0, 14).padEnd(14),
      t.of_tx_id ? 'OF' : '(manual)', '|', t.observacao,
    ].join(' | '));
  }
  const faltando = IDS.filter((i) => !alvos.some((a) => a.id === i));
  if (faltando.length) console.log('\n⚠️ não encontradas:', faltando.join(', '));

  if (!APLICAR) { console.log('\nSimulação. Rode com --apply pra apagar.'); return; }

  console.log('\ngravando...');
  // 1º registra o ignore (se falhar, NÃO apaga — melhor a linha ficar do que
  // sumir e voltar). 2º reverte o saldo do que estava pago. 3º apaga.
  const ignorar = alvos.filter((t) => t.of_tx_id)
    .map((t) => ({ grupo_id: t.grupo_id, of_tx_id: t.of_tx_id, motivo: 'duplicata do provedor' }));
  if (ignorar.length) {
    const { error: eIg } = await supabase.from('of_tx_ignoradas')
      .upsert(ignorar, { onConflict: 'grupo_id,of_tx_id' });
    if (eIg) { console.error('✗ falhou ao registrar o ignore, NADA foi apagado:', eIg.message); process.exit(1); }
    console.log('  registradas como ignoradas:', ignorar.length);
  }

  for (const t of alvos) {
    if (t.pago) {
      const mult = t.tipo === 'Gasto' ? 1 : -1;   // devolve o que tinha saído
      const { data: w } = await supabase.from('wallets')
        .select('id, saldo').eq('grupo_id', t.grupo_id).ilike('nome', t.carteira_nome).maybeSingle();
      if (w) await supabase.from('wallets').update({ saldo: (w.saldo || 0) + (t.valor * mult) }).eq('id', w.id);
    }
  }

  const { error: eDel } = await supabase.from('transacoes').delete().in('id', alvos.map((t) => t.id));
  if (eDel) { console.error('✗ erro ao apagar:', eDel.message); process.exit(1); }
  console.log('  apagadas:', alvos.length);
})();
