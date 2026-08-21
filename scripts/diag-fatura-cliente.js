// =============================================================================
// DIAGNÓSTICO (read-only) — por que a fatura de um cartão diverge do banco.
//
// ⚠️ NÃO ESCREVE NADA. Só lê e compara.
//
// Usa os MESMOS serviços canônicos que o painel (`faturaVista.valorExibido`,
// `faturaRollover.statusFatura`, `cicloFatura`) — reimplementar a conta aqui
// daria um número que não é o da tela, que é justamente o que se quer explicar.
//
// Além do valor, mostra a MATÉRIA-PRIMA de cada fonte possível, porque a
// pergunta "por que diverge" quase nunca se responde com o total: se responde
// com qual fonte ganhou e o que entrou nela.
//
// Rodar:
//   node scripts/diag-fatura-cliente.js <email> [filtro-do-cartao]
//   node scripts/diag-fatura-cliente.js jeniffer.jls@gmail.com gold
//
// ⚠️ O NOME DO CARTÃO É O DO EMISSOR, não o do banco: o Nubank da cliente
// chama-se 'gold'. Filtrar por 'nubank' devolve vazio.
//
// ⚠️ SEMPRE conferir o erro do select. Pedir uma coluna que não existe faz o
// Supabase falhar o select INTEIRO e devolver vazio — aqui isso apareceu como
// '0 transações' num ciclo que tinha 22 (era 'parcela_atual' em vez de
// 'parcela_num'). É a mesma armadilha registrada no CLAUDE.md.
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { cicloPorCompetencia, competenciaAtual, hojeSP } = require('../src/services/cicloFatura');
const { statusFatura } = require('../src/services/faturaRollover');
const { valorExibido } = require('../src/services/faturaVista');
const { somarFatura } = require('../src/services/valorFatura');
const { lerPrevistas } = require('../src/services/parcelasPrevistas');

const sb = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

const esc = (s) => String(s).replace(/([%_])/g, '\\$1');
const money = (v) => `R$ ${Number(v || 0).toFixed(2)}`;

const [, , emailArg, filtroArg] = process.argv;
if (!emailArg) { console.error('uso: node scripts/diag-fatura-cliente.js <email> [filtro]'); process.exit(1); }

(async () => {
  const { data: user } = await sb.from('users')
    .select('id, email, grupo_ativo, phone').eq('email', emailArg).maybeSingle();
  if (!user) { console.error('usuário não encontrado:', emailArg); process.exit(1); }
  console.log(`cliente ${user.email} · grupo ${user.grupo_ativo}\nhoje (SP): ${hojeSP()}\n`);

  let q = sb.from('wallets')
    .select('id, nome, tipo, saldo, of_conta_id, of_limite_usado, limite, '
          + 'dia_fechamento, dia_vencimento, datas_manuais, pagamento_minimo')
    .eq('grupo_id', user.grupo_ativo).eq('tipo', 'Crédito');
  if (filtroArg) q = q.ilike('nome', `%${esc(filtroArg)}%`);
  const { data: cartoes } = await q;

  if (!cartoes?.length) { console.error('nenhum cartão de crédito com esse filtro'); process.exit(1); }

  for (const c of cartoes) {
    console.log('═'.repeat(78));
    console.log(`CARTÃO  ${c.nome}   (${c.of_conta_id ? 'Open Finance' : 'manual'})`);
    console.log('═'.repeat(78));
    console.log(`  fecha dia ${c.dia_fechamento ?? '—'} · vence dia ${c.dia_vencimento ?? '—'}`
      + `${c.datas_manuais ? ' (datas corrigidas à mão)' : ''}`);
    console.log(`  wallets.saldo ......... ${money(c.saldo)}   ← nos cartões de OF é −(fatura simulada)`);
    console.log(`  of_limite_usado ....... ${money(c.of_limite_usado)}   ← limite comprometido, NÃO é fatura`);
    console.log(`  limite ................ ${money(c.limite)}`);

    // ── Faturas que o BANCO publicou ─────────────────────────────────────
    const { data: fats } = await sb.from('of_faturas')
      .select('competencia, total, pago, fechamento, vencimento, of_bill_id, pagamentos')
      .eq('cartao_id', c.id).order('competencia', { ascending: false });
    console.log(`\n  ── of_faturas (publicadas pelo emissor) — ${fats?.length || 0} ──`);
    for (const f of fats || []) {
      console.log(`     ${f.competencia}  total ${money(f.total).padStart(13)}  `
        + `pago ${money(f.pago).padStart(13)}  fech ${f.fechamento || '—'}  venc ${f.vencimento || '—'}`);
      const pgs = Array.isArray(f.pagamentos) ? f.pagamentos : [];
      for (const p of pgs) console.log(`        └ pagamento ${p.data || p.date || '?'} ${money(p.valor ?? p.amount)}`);
    }

    // ── O que a TELA mostra, competência por competência ─────────────────
    const compAtual = competenciaAtual(c);
    const comps = [-1, 0, 1].map((off) => {
      const [y, m] = compAtual.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + off, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });

    for (const comp of comps) {
      const ciclo = cicloPorCompetencia(c, comp);
      const st = await statusFatura(user.grupo_ativo, c, comp);
      const vista = await valorExibido(c, comp, st, { parcelasPrevistas: lerPrevistas });
      const prev = await lerPrevistas(c.id, comp);
      const marca = comp === compAtual ? ' ← COMPETÊNCIA ATUAL (é esta que o painel abre)' : '';

      console.log(`\n  ── ${comp}${marca}`);
      console.log(`     ciclo ......... ${ciclo.ini} → ${ciclo.fim}  (vence ${ciclo.venc})`);
      console.log(`     TELA MOSTRA ... ${money(vista.fatura)}   fonte: ${vista.fonte}`);
      console.log(`       pago ........ ${money(vista.pago)}   restante ${money(vista.restante)}`
        + `   ${vista.fechada ? 'fechada' : 'em aberto'}${vista.quitada ? ' · QUITADA' : ''}`);
      console.log(`     componentes:`);
      console.log(`       soma das transações do ciclo .. ${money(st.fatura)}`);
      console.log(`       parcelas previstas ............ ${money(prev?.total)}  (${prev?.itens?.length || 0} linha(s))`);
      for (const p of prev?.itens || []) {
        console.log(`          └ ${String(p.descricao || '').slice(0, 34).padEnd(35)} `
          + `${String(p.parcela_num)}/${p.parcela_total}  ${money(p.valor)}`);
      }
      console.log(`       pagamentos_fatura ............. ${money(st.pago)}`);
    }

    // ── As transações do ciclo ATUAL, uma a uma ──────────────────────────
    const ciclo = cicloPorCompetencia(c, compAtual);
    const { data: txs, error: eTx } = await sb.from('transacoes')
      .select('data, valor, tipo, categoria, transferencia, observacao, of_tx_id, of_bill_id, '
            + 'parcela_num, parcela_total')
      .eq('grupo_id', user.grupo_ativo).ilike('carteira_nome', esc(c.nome))
      .gte('data', ciclo.ini).lt('data', ciclo.fimExcl)
      .order('data');
    if (eTx) console.log('   ⚠️ SELECT FALHOU:', eTx.message);

    console.log(`\n  ── transações no ciclo ${ciclo.ini} → ${ciclo.fim} (${txs?.length || 0}) ──`);
    let soma = 0;
    for (const t of txs || []) {
      const parcela = t.parcela_total ? ` ${t.parcela_num}/${t.parcela_total}` : '';
      const sinal = t.tipo === 'Gasto' ? '+' : '−';
      console.log(`     ${String(t.data).slice(0, 10)}  ${sinal}${money(t.valor).padStart(12)}  `
        + `${String(t.categoria || '').slice(0, 16).padEnd(17)}`
        + `${String(t.observacao || '').slice(0, 30).padEnd(31)}`
        + `${t.of_bill_id ? 'bill✓' : '     '}${parcela}`);
      soma += (t.tipo === 'Gasto' ? 1 : -1) * (Number(t.valor) || 0);
    }
    console.log(`     ${''.padStart(11)}soma ingênua (só pra referência): ${money(soma)}`);
    console.log(`     soma CANÔNICA (valorFatura.somarFatura): ${money(somarFatura(txs || []))}`);
  }
})().catch((e) => { console.error('FALHOU:', e.message, e.stack); process.exit(1); });
