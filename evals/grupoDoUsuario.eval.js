// eval:grupo-do-usuario — toda conta tem um grupo, e o grupo que nasceu com ela
// não se abandona (relato do Paulo, nov/2026). Roda sem rede: Supabase falso.
const { ehGrupoOriginal, podeSairDoGrupo, escolherGrupo, garantirGrupoAtivo } = require('../src/services/grupoDoUsuario');

let ok = 0, falha = 0;
const conf = (c, m) => { if (c) ok++; else { falha++; console.log('  ✗ ' + m); } };
const igual = (a, b, m) => conf(JSON.stringify(a) === JSON.stringify(b), `${m} — veio ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);

const NASCEU = '2026-10-26T20:40:04.051456+00:00';
const paulo = { id: 'u1', name: 'Paulo ', created_at: NASCEU };
const original = { id: 'g1', nome: 'Pessoal de Paulo', dono_id: 'u1', created_at: NASCEU };

function fakeDb({ grupos = [], membros = [], users = [], falharLeitura = false, perdeCorrida = false } = {}) {
  const log = { insertsGrupo: 0, deletes: 0, rpcs: [] };
  let n = 0;
  const db = {
    log, grupos, users,
    rpc(nome) { log.rpcs.push(nome); return Promise.resolve({}); },
    from(t) {
      const f = { eq: [], is: [], modo: 'select', patch: null, row: null };
      const base = () => (t === 'grupos' ? grupos : t === 'grupo_membros' ? membros : users);
      const filtra = () => base().filter((l) => f.eq.every(([c, v]) => l[c] === v) && f.is.every(([c]) => l[c] == null));
      const exec = () => {
        if (f.modo === 'select') {
          if (falharLeitura && t !== 'users') return { data: null, error: { message: 'falhou' } };
          return { data: filtra().map((l) => ({ ...l })), error: null };
        }
        if (f.modo === 'insert') {
          log.insertsGrupo++; const r = { id: 'novo' + (++n), created_at: 'z', ...f.row }; grupos.push(r);
          return { data: r, error: null };
        }
        if (f.modo === 'delete') { log.deletes++; const a = filtra(); a.forEach((x) => grupos.splice(grupos.indexOf(x), 1)); return { data: null, error: null }; }
        if (perdeCorrida) { users.forEach((u) => { u.grupo_ativo = 'outro'; }); return { data: [], error: null }; }
        const a = filtra(); a.forEach((l) => Object.assign(l, f.patch));
        return { data: a.map((l) => ({ id: l.id })), error: null };
      };
      const q = {
        select() { return q; }, order() { return q; },
        insert(r) { f.modo = 'insert'; f.row = r; return q; },
        update(p) { f.modo = 'update'; f.patch = p; return q; },
        delete() { f.modo = 'delete'; return q; },
        eq(c, v) { f.eq.push([c, v]); return q; },
        is(c, v) { f.is.push([c, v]); return q; },
        single() { return Promise.resolve(exec()); },
        maybeSingle() { const r = exec(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
        then(a, b) { return Promise.resolve(exec()).then(a, b); },
      };
      return q;
    },
  };
  return db;
}

(async () => {
  console.log('§1 qual é o grupo original');
  conf(ehGrupoOriginal(original, paulo), 'nasceu com a conta');
  conf(ehGrupoOriginal({ ...original, nome: 'Churrasco (Rateio)' }, paulo), 'renomeado continua sendo o original');
  conf(!ehGrupoOriginal({ ...original, created_at: '2026-11-01T00:00:00+00:00' }, paulo), 'grupo criado depois não é');
  conf(!ehGrupoOriginal({ ...original, dono_id: 'u2' }, paulo), 'grupo de outro dono não é');
  conf(!ehGrupoOriginal({ ...original, created_at: 'lixo' }, paulo), 'data inválida não afirma nada');
  // O caso da Luciene: recebeu por transferência um grupo MAIS VELHO que a conta dela.
  const ela = { id: 'u2', created_at: '2026-11-07T02:44:43+00:00' };
  conf(!ehGrupoOriginal({ id: 'g1', dono_id: 'u2', created_at: NASCEU }, ela), 'grupo recebido por transferência não é o original');

  console.log('§2 quem pode sair');
  conf(!podeSairDoGrupo(original, paulo), 'do Pessoal não sai');
  conf(!podeSairDoGrupo({ ...original, nome: 'Churrasco (Rateio)' }, paulo), 'o caso do relato: renomeado também não');
  conf(!podeSairDoGrupo({ id: 'g', nome: 'Pessoal antigo', dono_id: 'u1', created_at: '2020-01-01T00:00:00Z' }, paulo), 'conta legada: o nome ainda protege');
  conf(podeSairDoGrupo({ id: 'g', nome: 'Viagem', dono_id: 'u1', created_at: '2026-11-01T00:00:00Z' }, paulo), 'grupo criado depois: dono sai');
  conf(podeSairDoGrupo({ id: 'g', nome: 'Pessoal de Outra', dono_id: 'u2', created_at: NASCEU }, paulo), 'membro sai de qualquer grupo alheio');
  conf(!podeSairDoGrupo(null, paulo), 'sem grupo: não');

  console.log('§3 pra onde volta');
  igual(escolherGrupo([{ id: 'b', created_at: '2' }, { id: 'a', created_at: '1' }], [{ grupo_id: 'm', created_at: '0' }]), 'a', 'o próprio mais antigo vem antes de participação');
  igual(escolherGrupo([], [{ grupo_id: 'n', created_at: '2' }, { grupo_id: 'm', created_at: '1' }]), 'm', 'sem próprio: a participação mais antiga');
  igual(escolherGrupo([], []), null, 'nada: nulo');

  console.log('§4 conta sem grupo nenhum (o caso do relato)');
  let db = fakeDb({ users: [{ id: 'u1', grupo_ativo: null, wallet_padrao_id: 'w-velha' }] });
  let r = await garantirGrupoAtivo({ ...paulo, grupo_ativo: null }, { supabase: db });
  igual(r, { grupoId: 'novo1', criado: true }, 'cria um grupo novo');
  igual(db.grupos[0].nome, 'Pessoal de Paulo', 'nome sem espaço sobrando');
  igual(db.grupos[0].dono_id, 'u1', 'ele é o dono');
  igual(db.users[0].grupo_ativo, 'novo1', 'vira o grupo ativo');
  igual(db.users[0].wallet_padrao_id, null, 'solta a conta padrão do grupo antigo');
  igual(db.log.rpcs, ['criar_categorias_padrao', 'criar_categorias_extra'], 'recebe as categorias de conta nova');

  console.log('§5 tendo grupo, não cria outro');
  db = fakeDb({ grupos: [{ id: 'g9', dono_id: 'u1', created_at: '1' }], users: [{ id: 'u1', grupo_ativo: null, wallet_padrao_id: 'w' }] });
  r = await garantirGrupoAtivo({ ...paulo, grupo_ativo: null }, { supabase: db });
  igual(r, { grupoId: 'g9', criado: false }, 'volta pro grupo dele');
  igual(db.log.insertsGrupo, 0, 'nenhum grupo novo');
  igual(db.users[0].wallet_padrao_id, 'w', 'conta padrão intacta');
  db = fakeDb({ users: [] });
  r = await garantirGrupoAtivo({ ...paulo, grupo_ativo: 'g5' }, { supabase: db });
  igual(r, { grupoId: 'g5', criado: false }, 'já tem grupo: nem consulta');

  console.log('§6 dez chamadas de uma vez');
  db = fakeDb({ users: [{ id: 'u1', grupo_ativo: null }] });
  const rs = await Promise.all(Array.from({ length: 10 }, () => garantirGrupoAtivo({ ...paulo, grupo_ativo: null }, { supabase: db })));
  igual(db.log.insertsGrupo, 1, 'um grupo só');
  conf(rs.every((x) => x.grupoId === 'novo1'), 'todas recebem o mesmo');

  console.log('§7 guardas');
  db = fakeDb({ users: [{ id: 'u1', grupo_ativo: null }], falharLeitura: true });
  r = await garantirGrupoAtivo({ ...paulo, grupo_ativo: null }, { supabase: db });
  igual(r, { grupoId: null, criado: false }, 'leitura falhou: não responde grupo');
  igual(db.log.insertsGrupo, 0, 'leitura falhou: não cria às cegas');
  db = fakeDb({ users: [{ id: 'u1', grupo_ativo: null }], perdeCorrida: true });
  r = await garantirGrupoAtivo({ ...paulo, grupo_ativo: null }, { supabase: db });
  igual(r, { grupoId: 'outro', criado: false }, 'perdeu a corrida: usa o que ganhou');
  igual(db.log.deletes, 1, 'perdeu a corrida: apaga o grupo vazio que criou');
  igual(await garantirGrupoAtivo(null), { grupoId: null, criado: false }, 'sem usuário');

  console.log(`\n${ok} ok · ${falha} falha(s)`);
  if (falha) process.exit(1);
})();
