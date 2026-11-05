// eval:parcelas-irmas — editar UMA parcela e levar nome/categoria às outras da
// mesma compra (relato do Bruno, nov/2026). Roda sem rede: Supabase falso.
const {
  semMarcador, descricaoParaIrma, ehParcelaComIrmas, planoDasIrmas, aplicarNasParcelas,
} = require('../src/services/parcelasIrmas');

let ok = 0, falha = 0;
const conf = (c, m) => { if (c) { ok++; } else { falha++; console.log('  ✗ ' + m); } };
const igual = (a, b, m) => conf(JSON.stringify(a) === JSON.stringify(b), `${m} — veio ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);

// ── Supabase falso: filtra eq/neq/in e registra os updates ──────────────────
function fakeDb(linhas, { falharLeitura = false } = {}) {
  const updates = [];
  const db = {
    linhas, updates,
    from() {
      const f = { eq: [], neq: [], in: null, patch: null, modo: 'select' };
      const filtra = () => linhas.filter((l) =>
        f.eq.every(([c, v]) => l[c] === v) && f.neq.every(([c, v]) => l[c] !== v) && (!f.in || f.in[1].includes(l[f.in[0]])));
      const q = {
        select() { return q; },
        update(p) { f.modo = 'update'; f.patch = p; return q; },
        eq(c, v) { f.eq.push([c, v]); return q; },
        neq(c, v) { f.neq.push([c, v]); return q; },
        in(c, v) { f.in = [c, v]; return q; },
        then(res, rej) {
          if (f.modo === 'select') {
            if (falharLeitura) return Promise.resolve({ data: filtra().map((l) => ({ ...l })), error: { message: 'falhou' } }).then(res, rej);
            return Promise.resolve({ data: filtra().map((l) => ({ ...l })), error: null }).then(res, rej);
          }
          const alvo = filtra();
          alvo.forEach((l) => Object.assign(l, f.patch));
          updates.push({ patch: f.patch, ids: alvo.map((l) => l.id) });
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return db;
}

const G = 'grupo-1';
const compra = (n, extra = {}) => ({
  id: 'p' + n, grupo_id: G, parcela_grupo: 'OFKABUM', parcela_num: n, parcela_total: 10,
  carteira_nome: 'Nubank Croma', categoria: 'Encomendas', observacao: `Mlp*Kabum-Fast Shop ${n}/10`, ...extra,
});

(async () => {
  console.log('§1 marcador de parcela');
  igual(semMarcador('Mlp*Kabum-Fast Shop 1/10'), 'Mlp*Kabum-Fast Shop', 'tira o N/M do fim');
  igual(semMarcador('Celular (2/3)'), 'Celular', 'tira o (N/M) do fim');
  igual(semMarcador('Boombox 4'), 'Boombox 4', 'número sem barra não é marcador');
  igual(semMarcador('1/10'), '1/10', 'descrição só de marcador fica como está');

  console.log('§2 nome que a irmã recebe');
  const ed = { parcela_num: 1, parcela_total: 10 };
  igual(descricaoParaIrma('Boombox 4', ed, { parcela_num: 3 }), 'Boombox 4', 'nome sem marcador vai igual');
  igual(descricaoParaIrma('Kabum Boombox 1/10', ed, { parcela_num: 3 }), 'Kabum Boombox 3/10', 'marcador da editada vira o da irmã');
  igual(descricaoParaIrma('Kabum (1/10)', ed, { parcela_num: 7 }), 'Kabum (7/10)', 'mantém os parênteses');
  igual(descricaoParaIrma('PNEU 205/55', ed, { parcela_num: 3 }), 'PNEU 205/55', '"205/55" não é o marcador desta parcela');
  igual(descricaoParaIrma('Kabum 2/10', ed, { parcela_num: 3 }), 'Kabum 2/10', 'marcador de OUTRA parcela não é trocado');

  console.log('§3 quem é parcela com irmãs');
  conf(ehParcelaComIrmas(compra(1)), 'parcela 1/10 com grupo');
  conf(!ehParcelaComIrmas({ parcela_grupo: 'X', parcela_total: 1 }), '1/1 não tem irmã');
  conf(!ehParcelaComIrmas({ parcela_grupo: null, parcela_total: 10 }), 'sem grupo não se sabe a compra');

  console.log('§4 plano: só o que muda');
  const depois = { ...compra(1), categoria: 'Eletrônicos', observacao: 'Boombox 4' };
  const plano = planoDasIrmas(depois, [compra(1), compra(2), compra(3, { categoria: 'Eletrônicos', observacao: 'Boombox 4' })]);
  igual(plano.map((p) => p.id), ['p2'], 'pula a própria e a que já está igual');
  igual(plano[0].patch, { categoria: 'Eletrônicos', observacao: 'Boombox 4' }, 'leva nome e categoria');
  const soCat = planoDasIrmas({ ...compra(1), categoria: 'Eletrônicos' }, [compra(2)]);
  igual(soCat[0].patch, { categoria: 'Eletrônicos' }, 'nome do banco com marcador: a irmã mantém o DELA');

  console.log('§5 o caso do relato, ponta a ponta no banco falso');
  const linhas = [];
  for (let n = 1; n <= 10; n++) linhas.push(compra(n));
  // Ruído: mesma compra em OUTRO cartão (hash igual), outro grupo, outra compra.
  linhas.push(compra(2, { id: 'outroCartao', carteira_nome: 'Itaú' }));
  linhas.push(compra(2, { id: 'outroGrupo', grupo_id: 'grupo-2' }));
  linhas.push({ ...compra(2), id: 'outraCompra', parcela_grupo: 'OFOUTRA' });
  linhas.push({ ...compra(2), id: 'outroTotal', parcela_total: 12 });
  const db = fakeDb(linhas);
  const antes = { ...linhas[0] };
  Object.assign(linhas[0], { categoria: 'Eletrônicos', observacao: 'Boombox 4' });
  const r = await aplicarNasParcelas({ grupoId: G, antes, depois: { ...linhas[0] } }, { supabase: db });
  igual(r, { atualizadas: 9, irmas: 9 }, 'as 9 irmãs mudaram');
  conf(linhas.slice(0, 10).every((l) => l.categoria === 'Eletrônicos' && l.observacao === 'Boombox 4'), 'as 10 parcelas ficaram iguais');
  for (const id of ['outroCartao', 'outroGrupo', 'outraCompra', 'outroTotal']) {
    const l = linhas.find((x) => x.id === id);
    conf(l.categoria === 'Encomendas' && l.observacao.startsWith('Mlp'), `${id} não foi tocada`);
  }
  igual(db.updates.length, 1, 'mesma mudança → um update só');
  conf(db.updates.every((u) => u.patch.valor === undefined && u.patch.data === undefined && u.patch.pago === undefined), 'valor/data/pago nunca andam');

  console.log('§6 guardas');
  const db2 = fakeDb([compra(1), compra(2)], { falharLeitura: true });
  igual(await aplicarNasParcelas({ grupoId: G, antes: compra(1), depois: { ...compra(1), categoria: 'X' } }, { supabase: db2 }), { atualizadas: 0, irmas: 0 }, 'leitura falhou: nada escrito');
  igual(db2.updates.length, 0, 'nenhum update depois de leitura falha');
  const db3 = fakeDb([compra(1), compra(2)]);
  igual(await aplicarNasParcelas({ grupoId: G, antes: { ...compra(1), parcela_grupo: null }, depois: compra(1) }, { supabase: db3 }), { atualizadas: 0, irmas: 0 }, 'linha que não é parcela não mexe em nada');
  const db4 = fakeDb([compra(1), compra(2)]);
  const r4 = await aplicarNasParcelas({ grupoId: G, antes: compra(1), depois: compra(1) }, { supabase: db4 });
  igual(r4.atualizadas, 0, 'sem mudança: nenhum update à toa');
  igual(db4.updates.length, 0, 'sem mudança: zero idas de escrita');
  // Antes da edição a linha estava no Nubank; o filtro é pela carteira de ANTES.
  const db5 = fakeDb([compra(1), compra(2)]);
  await aplicarNasParcelas({ grupoId: G, antes: compra(1), depois: { ...compra(1), carteira_nome: 'Itaú', categoria: 'Y' } }, { supabase: db5 });
  igual(db5.linhas[1].categoria, 'Y', 'mudar a conta da editada não perde as irmãs');

  console.log(`\n${ok} ok · ${falha} falha(s)`);
  if (falha) process.exit(1);
})();
