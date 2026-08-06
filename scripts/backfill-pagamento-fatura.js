// =============================================================================
// BACKFILL: pagamentos de fatura que entraram como GASTO.
//
// A fatura é paga UMA vez e aparece nos DOIS lados — sai da conta e abate no
// cartão. Contar o pagamento como gasto conta em DOBRO, porque cada compra da
// fatura já foi categorizada uma a uma. O usuário via 73% do mês em "Outros".
//
// A detecção por descrição existia só no trilho Pluggy e não foi portada pro
// Celcoin (nem valia pro import de OFX). Corrigido em
// services/categorizar.ehPagamentoFaturaDescricao — mas o sync NUNCA reescreve
// linha existente (de propósito: senão apagaria correção manual do usuário),
// então o histórico precisa deste script.
//
// Medido antes: 33 linhas, R$ 35.314,88, em 8 grupos.
//
// O que faz: marca `transferencia = true` e põe a categoria 'Fatura'.
// NÃO apaga nada, não mexe em saldo (o saldo já refletiu a saída de dinheiro —
// o que muda é só a linha parar de contar como CONSUMO no relatório).
//
// Uso:
//   node scripts/backfill-pagamento-fatura.js            # simulação
//   node scripts/backfill-pagamento-fatura.js --apply    # grava
//   node scripts/backfill-pagamento-fatura.js --grupo=<uuid>
// =============================================================================
require('dotenv').config();
const supabase = require('../src/db/supabase');
const { ehPagamentoFaturaDescricao, CATEGORIA_FATURA } = require('../src/services/categorizar');

const APLICAR = process.argv.includes('--apply');
const ARG_GRUPO = (process.argv.find((a) => a.startsWith('--grupo=')) || '').split('=')[1];
const brl = (v) => `R$ ${Number(v).toFixed(2)}`;

(async () => {
  console.log(APLICAR ? '⚠️  MODO GRAVAÇÃO' : '🔍 SIMULAÇÃO (nada será gravado)', '\n');

  // Paginado: o Supabase corta em 1000 e não avisa.
  const linhas = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('transacoes')
      .select('id, grupo_id, data, observacao, valor, tipo, categoria, transferencia, carteira_nome')
      .eq('transferencia', false)
      .order('id').range(from, from + 999);
    if (ARG_GRUPO) q = q.eq('grupo_id', ARG_GRUPO);
    const { data, error } = await q;
    if (error) { console.error('erro lendo transacoes:', error.message); process.exit(1); }
    linhas.push(...data);
    if (data.length < 1000) break;
  }

  const alvo = linhas.filter((t) => ehPagamentoFaturaDescricao(t.observacao));

  console.log('transações não-transferência lidas:', linhas.length);
  console.log('pagamentos de fatura contados como gasto:', alvo.length);
  console.log('valor que sai do relatório de gastos:', brl(alvo.reduce((s, t) => s + Number(t.valor), 0)));
  console.log('grupos afetados:', new Set(alvo.map((t) => t.grupo_id)).size, '\n');

  for (const t of alvo) {
    console.log([
      String(t.data).slice(0, 10),
      brl(t.valor).padStart(12),
      String(t.tipo).padEnd(12),
      `${String(t.categoria).slice(0, 14).padEnd(14)} → ${CATEGORIA_FATURA}`,
      String(t.carteira_nome || '').slice(0, 16).padEnd(16),
      String(t.observacao).slice(0, 34),
    ].join(' | '));
  }

  if (!APLICAR) { console.log('\nSimulação. Rode com --apply pra gravar.'); return; }

  console.log('\ngravando...');
  let ok = 0; let erros = 0;
  for (const t of alvo) {
    const { error } = await supabase.from('transacoes')
      .update({ transferencia: true, categoria: CATEGORIA_FATURA }).eq('id', t.id);
    if (error) { erros++; if (erros <= 3) console.error('  erro em', t.id, error.message); }
    else ok++;
  }
  console.log(`atualizadas: ${ok} · erros: ${erros}`);
})();
