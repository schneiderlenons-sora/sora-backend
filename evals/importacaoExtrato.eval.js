// =============================================================================
// EVAL: mover pra conta certa o que já foi importado na conta errada
// (services/importacaoExtrato.js) — relato de nov/2026, fatura do cartão
// importada na conta corrente e reimportação que dizia "0 importadas".
//
// Trava: só o próprio grupo, só lançamento IMPORTADO (fitid, sem of_tx_id),
// só os fitids pedidos, nada que já esteja no destino, e lista vazia não faz nada.
//
// Rodar:  npm run eval:importacao-extrato
// =============================================================================
const { moverImportadas } = require('../src/services/importacaoExtrato');

const falhas = [];
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

function bancoFake(linhas) {
  return {
    t: linhas,
    from() {
      const filtros = []; let valores = null; let erro = null;
      const api = {
        update(v) { valores = v; return api; },
        eq(c, v) { filtros.push((r) => r[c] === v); return api; },
        in(c, v) { filtros.push((r) => v.includes(r[c])); return api; },
        is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
        neq(c, v) { filtros.push((r) => r[c] !== v); return api; },
        falhar(e) { erro = e; return api; },
        select() {
          if (erro) return Promise.resolve({ data: null, error: erro });
          const alvo = linhas.filter((r) => filtros.every((f) => f(r)));
          for (const r of alvo) Object.assign(r, valores);
          return Promise.resolve({ data: alvo.map((r) => ({ id: r.id })), error: null });
        },
      };
      return api;
    },
  };
}

(async () => {
  const linhas = () => ([
    { id: 1, grupo_id: 'g1', fitid: 'A', of_tx_id: null, carteira_nome: 'Conta corrente' },
    { id: 2, grupo_id: 'g1', fitid: 'B', of_tx_id: null, carteira_nome: 'Conta corrente' },
    { id: 3, grupo_id: 'g1', fitid: 'C', of_tx_id: null, carteira_nome: 'Nubank Crédito' },   // já no destino
    { id: 4, grupo_id: 'g1', fitid: 'D', of_tx_id: 'of-9', carteira_nome: 'Conta corrente' }, // veio do Open Finance
    { id: 5, grupo_id: 'g2', fitid: 'A', of_tx_id: null, carteira_nome: 'Conta corrente' },   // outro grupo
    { id: 6, grupo_id: 'g1', fitid: 'E', of_tx_id: null, carteira_nome: 'Conta corrente' },   // não foi pedido
    { id: 7, grupo_id: 'g1', fitid: null, of_tx_id: null, carteira_nome: 'Conta corrente' },  // lançado à mão
  ]);

  {
    const db = bancoFake(linhas());
    const r = await moverImportadas(db, { grupoId: 'g1', fitids: ['A', 'B', 'C', 'D', 'A'], destino: 'Nubank Crédito' });
    eq(r, { movidas: 2 }, 'move só A e B (C já está lá, D é do Open Finance, A repetido conta uma vez)');
    const onde = Object.fromEntries(db.t.map((x) => [x.id, x.carteira_nome]));
    eq([onde[1], onde[2]], ['Nubank Crédito', 'Nubank Crédito'], 'A e B foram pro cartão');
    eq(onde[4], 'Conta corrente', '⚠️ lançamento do Open Finance NÃO se move');
    eq(onde[5], 'Conta corrente', '⚠️ mesmo fitid em OUTRO grupo NÃO se move');
    eq(onde[6], 'Conta corrente', 'fitid não pedido fica onde está');
    eq(onde[7], 'Conta corrente', 'lançamento à mão (sem fitid) não se move');
  }
  {
    const db = bancoFake(linhas());
    eq(await moverImportadas(db, { grupoId: 'g1', fitids: [], destino: 'Nubank Crédito' }), { movidas: 0 }, 'lista vazia não faz nada');
    eq(await moverImportadas(db, { grupoId: 'g1', fitids: ['A'], destino: '' }), { movidas: 0 }, 'sem destino não faz nada');
    eq(await moverImportadas(db, { grupoId: '', fitids: ['A'], destino: 'X' }), { movidas: 0 }, 'sem grupo não faz nada');
    eq(await moverImportadas(db, { grupoId: 'g1', fitids: [null, 7, '  '], destino: 'X' }), { movidas: 0 }, 'lixo na lista não vira filtro');
    eq(db.t.every((x) => x.carteira_nome !== 'X'), true, 'nada escrito nesses casos');
  }
  {
    const db = bancoFake(linhas());
    const orig = db.from; db.from = () => orig().falhar(new Error('falha de rede'));
    let erro = null;
    try { await moverImportadas(db, { grupoId: 'g1', fitids: ['A'], destino: 'Nubank Crédito' }); } catch (e) { erro = e; }
    eq(!!erro, true, 'falha do banco SOBE (a rota responde erro, não "movi 0")');
  }

  if (falhas.length) { console.log(`✗ ${falhas.length} falha(s):\n - ` + falhas.join('\n - ')); process.exit(1); }
  console.log('✓ importação de extrato: mover pra conta certa — tudo passou');
})();
