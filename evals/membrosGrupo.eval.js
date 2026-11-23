// =============================================================================
// EVAL DE ROTA — remover membro e mudar papel (DELETE/PATCH /api/grupos/membro/:id)
//
// Relato de cliente (nov/2026): "sou ADM e não consigo remover um membro".
// O dono do grupo que nasceu com a conta não tem linha em `grupo_membros`, e as
// duas rotas procuravam o papel de quem pediu só ali → 403.
//
// O que não pode acontecer:
//   · o DONO (com ou sem linha em grupo_membros) ser barrado;
//   · um membro comum, ou alguém de fora, remover ou mudar papel;
//   · um admin promovido remover ou rebaixar QUEM CRIOU o grupo;
//   · falha de gravação responder sucesso;
//   · o membro removido ficar preso lendo o grupo do qual saiu.
//
// Roda as rotas REAIS sobre um banco falso.
// Rodar: npm run eval:membros-grupo
// =============================================================================
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';

const falhas = [];
let casos = 0;
const ok = (c, m) => { casos++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function bancoFalso(tabelas, cfg) {
  const copia = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null;
    const linhas = () => (tabelas[nome] = tabelas[nome] || []).filter((r) => filtros.every(([c, v]) => r[c] === v));
    const executar = () => {
      if (modo === 'update') {
        if (cfg.falhaUpdate === nome) return { data: null, error: { message: 'falhou de propósito' } };
        const alvo = linhas();
        alvo.forEach((r) => Object.assign(r, patch));
        return { data: alvo[0] || null, error: null };
      }
      if (modo === 'delete') {
        if (cfg.falhaDelete === nome) return { data: null, error: { message: 'falhou de propósito' } };
        const fora = new Set(linhas());
        tabelas[nome] = tabelas[nome].filter((r) => !fora.has(r));
        return { data: null, error: null };
      }
      return { data: linhas()[0] || null, error: null, todas: linhas() };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(c, v) { filtros.push([c, v]); return q; },
      update(p) { modo = 'update'; patch = p; return q; },
      delete() { modo = 'delete'; return q; },
      maybeSingle() { const r = executar(); return Promise.resolve({ data: copia(r.data), error: r.error }); },
      single() { const r = executar(); return Promise.resolve({ data: copia(r.data), error: r.error }); },
      then(res, rej) { try { const r = executar(); return Promise.resolve(res({ data: copia(r.todas || r.data), error: r.error })); } catch (e) { return rej ? rej(e) : Promise.reject(e); } },
    };
    return q;
  };
  return { from };
}

function carregarRota(db, rota, metodo) {
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return db;
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.join(RAIZ, 'src/routes/grupos.js'));
  Module._load = origLoad;
  const camada = router.stack.find((c) => c.route?.path === rota && c.route?.methods?.[metodo]);
  return camada.route.stack[camada.route.stack.length - 1].handle;
}

// Cenário base:
//   gP = grupo que nasceu com a conta do DONO (sem linha dele em grupo_membros);
//        membros: Bia (escrita, grupo_ativo = gP) e Caio (admin promovido)
//   gC = grupo criado pelo botão "Criar grupo" (dono TEM linha admin);
//        membros: dono (admin), Caio (admin promovido), Davi (leitura)
//   gX = grupo de outra pessoa, sem relação com ninguém acima
const BASE = () => ({
  users: [
    { id: 'dono', grupo_ativo: 'gP' },
    { id: 'bia', grupo_ativo: 'gP' },
    { id: 'caio', grupo_ativo: 'gC' },
    { id: 'davi', grupo_ativo: 'gD' },
    { id: 'fora', grupo_ativo: 'gX' },
  ],
  grupos: [
    { id: 'gP', dono_id: 'dono', created_at: '2026-01-01T00:00:00Z' },
    { id: 'gC', dono_id: 'dono', created_at: '2026-03-01T00:00:00Z' },
    { id: 'gB', dono_id: 'bia', created_at: '2026-02-01T00:00:00Z' },
    { id: 'gD', dono_id: 'davi', created_at: '2026-02-01T00:00:00Z' },
    { id: 'gX', dono_id: 'fora', created_at: '2026-02-01T00:00:00Z' },
  ],
  grupo_membros: [
    { id: 'm-bia', grupo_id: 'gP', user_id: 'bia', papel: 'escrita' },
    { id: 'm-caioP', grupo_id: 'gP', user_id: 'caio', papel: 'admin' },
    { id: 'm-donoC', grupo_id: 'gC', user_id: 'dono', papel: 'admin' },
    { id: 'm-caioC', grupo_id: 'gC', user_id: 'caio', papel: 'admin' },
    { id: 'm-davi', grupo_id: 'gC', user_id: 'davi', papel: 'leitura' },
  ],
});

async function chamar({ metodo, quem, membroId, corpo = {}, cfg = {}, ajustar }) {
  const tabelas = BASE();
  if (ajustar) ajustar(tabelas);
  const h = carregarRota(bancoFalso(tabelas, cfg), '/membro/:membro_id', metodo);
  let status = 200, json = null;
  const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
  await h({ params: { membro_id: membroId }, body: corpo, authUser: { id: quem } }, res);
  const linha = (id) => tabelas.grupo_membros.find((m) => m.id === id);
  const ativo = (id) => tabelas.users.find((u) => u.id === id)?.grupo_ativo;
  return { status, json, linha, ativo };
}
const remover = (quem, membroId, extra = {}) => chamar({ metodo: 'delete', quem, membroId, ...extra });
const mudar = (quem, membroId, papel, extra = {}) => chamar({ metodo: 'patch', quem, membroId, corpo: { papel }, ...extra });

(async () => {
  // 1. O relato: dono do grupo original (SEM linha) remove um convidado.
  let r = await remover('dono', 'm-bia');
  eq(r.status, 200, '1. dono sem linha remove membro');
  eq(r.linha('m-bia'), undefined, '1. a linha some');
  eq(r.ativo('bia'), 'gB', '1. o removido volta pro grupo DELE (não fica preso no gP)');

  // 2. Dono sem linha muda o papel de um convidado.
  r = await mudar('dono', 'm-bia', 'leitura');
  eq(r.status, 200, '2. dono sem linha muda papel');
  eq(r.linha('m-bia').papel, 'leitura', '2. papel gravado');

  // 3. Admin promovido remove outro membro (já funcionava; não pode regredir).
  r = await remover('caio', 'm-davi');
  eq(r.status, 200, '3. admin promovido remove membro comum');
  eq(r.linha('m-davi'), undefined, '3. a linha some');
  eq(r.ativo('davi'), 'gD', '3. grupo ativo de quem estava em outro grupo fica intacto');

  // 4. Admin promovido NÃO remove quem criou o grupo.
  r = await remover('caio', 'm-donoC');
  eq(r.status, 400, '4. admin promovido não remove o dono');
  ok(!!r.linha('m-donoC'), '4. a linha do dono continua');

  // 5. Admin promovido NÃO rebaixa quem criou o grupo.
  r = await mudar('caio', 'm-donoC', 'leitura');
  eq(r.status, 400, '5. admin promovido não rebaixa o dono');
  eq(r.linha('m-donoC').papel, 'admin', '5. dono segue admin');

  // 6. Membro comum não remove nem muda papel.
  r = await remover('bia', 'm-caioP');
  eq(r.status, 403, '6. membro escrita não remove');
  ok(!!r.linha('m-caioP'), '6. linha intacta');
  r = await mudar('davi', 'm-caioC', 'leitura');
  eq(r.status, 403, '6. membro leitura não muda papel');
  eq(r.linha('m-caioC').papel, 'admin', '6. papel intacto');

  // 7. Alguém de fora do grupo não mexe em nada.
  r = await remover('fora', 'm-bia');
  eq(r.status, 403, '7. de fora não remove');
  ok(!!r.linha('m-bia'), '7. linha intacta');
  r = await mudar('fora', 'm-bia', 'admin');
  eq(r.status, 403, '7. de fora não se promove nem promove ninguém');
  eq(r.linha('m-bia').papel, 'escrita', '7. papel intacto');

  // 8. Dono com uma linha "escrita" no PRÓPRIO grupo (link aberto por ele mesmo)
  //    continua podendo administrar: ser dono vence o papel de membro.
  const comLinhaEscrita = (t) => t.grupo_membros.push({ id: 'm-donoP', grupo_id: 'gP', user_id: 'dono', papel: 'escrita' });
  r = await remover('dono', 'm-bia', { ajustar: comLinhaEscrita });
  eq(r.status, 200, '8. dono com linha escrita remove');
  r = await mudar('dono', 'm-bia', 'leitura', { ajustar: comLinhaEscrita });
  eq(r.status, 200, '8. dono com linha escrita muda papel');

  // 9. Remover a si mesmo segue indo pelo "sair do grupo".
  r = await remover('caio', 'm-caioP');
  eq(r.status, 400, '9. remover a si mesmo → 400');
  ok(!!r.linha('m-caioP'), '9. linha intacta');

  // 10. Entradas inválidas.
  r = await remover('dono', 'nao-existe');
  eq(r.status, 404, '10. membro inexistente → 404');
  r = await mudar('dono', 'm-bia', 'superadmin');
  eq(r.status, 400, '10. papel inválido → 400');
  eq(r.linha('m-bia').papel, 'escrita', '10. papel inválido não grava');
  r = await remover('ninguem', 'm-bia');
  eq(r.status, 404, '10. usuário inexistente → 404');
  ok(!!r.linha('m-bia'), '10. linha intacta');

  // 11. Falha de gravação não responde sucesso.
  r = await remover('dono', 'm-bia', { cfg: { falhaDelete: 'grupo_membros' } });
  eq(r.status, 500, '11. delete que falha → 500');
  ok(!!r.linha('m-bia'), '11. linha intacta');
  eq(r.ativo('bia'), 'gP', '11. grupo ativo do membro não muda se a remoção falhou');
  r = await mudar('dono', 'm-bia', 'leitura', { cfg: { falhaUpdate: 'grupo_membros' } });
  eq(r.status, 500, '11. update que falha → 500');

  // 12. Grupo apontado pela linha sumiu: ninguém administra (nada é apagado).
  r = await remover('dono', 'm-bia', { ajustar: (t) => { t.grupos = t.grupos.filter((g) => g.id !== 'gP'); } });
  eq(r.status, 403, '12. grupo inexistente → 403');
  ok(!!r.linha('m-bia'), '12. linha intacta');

  if (falhas.length) {
    console.error(`\n❌ ${falhas.length} de ${casos} falharam:`);
    for (const f of falhas) console.error('  ·', f);
    process.exit(1);
  }
  console.log(`✅ membros do grupo: ${casos} verificações ok`);
})().catch((e) => { console.error(e); process.exit(1); });
