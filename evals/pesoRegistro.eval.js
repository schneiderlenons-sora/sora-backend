// =============================================================================
// EVAL — registro de PESO com data (Saúde do Grow).
//
// O que trava:
//   1. "hoje" é o dia de São Paulo (às 21h o UTC já virou amanhã);
//   2. peso e data validados; data futura recusada;
//   3. data dita no WhatsApp ("ontem", "dia 10", "10/11") é sempre a mais
//      recente que JÁ PASSOU — nunca o futuro;
//   4. o comando do WhatsApp: "peso 80" sem kg funciona (antes não!), "estou
//      com 80" sem kg NÃO é peso (pode ser dinheiro), cauda que não é data não
//      é capturada;
//   5. rotas: criar com data e avisar que substituiu, editar sem colidir com
//      outro dia, apagar só o PRÓPRIO registro, falha de leitura não vira vazio.
//
// Rodar: npm run eval:peso
// =============================================================================
const path = require('path');
const p = require('../src/services/pesoRegistro');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`); };

(async () => {
  console.log('§1 hoje em São Paulo');
  eq(p.hojeSP(new Date('2026-11-16T23:30:00-03:00')), '2026-11-16', '23h30 em SP ainda é dia 16 (UTC já é 17)');
  eq(p.hojeSP(new Date('2026-11-17T02:59:00Z')), '2026-11-16', '02:59 UTC = 23:59 de SP do dia anterior');
  eq(p.hojeSP(new Date('2026-11-17T03:00:00Z')), '2026-11-17', '03:00 UTC = meia-noite em SP');

  const H = '2026-11-16';
  console.log('§2 validar registro');
  eq(p.validarRegistro({ peso_kg: '80,5' }, H), { peso_kg: 80.5, data: H, observacao: null }, 'vírgula; sem data = hoje');
  eq(p.validarRegistro({ peso_kg: 72.25, data: '2026-11-10', observacao: '  em jejum  ' }, H),
    { peso_kg: 72.25, data: '2026-11-10', observacao: 'em jejum' }, 'data passada + observação limpa');
  eq(p.validarRegistro({ peso_kg: '80', data: '2026-11-17' }, H).erro, 'A data não pode ser no futuro.', 'amanhã recusado');
  eq(p.validarRegistro({ peso_kg: '80', data: H }, H).data, H, 'hoje aceito');
  eq(p.validarRegistro({ peso_kg: '80', data: '2026-02-30' }, H).erro, 'Data inválida.', '30/02 não existe');
  eq(p.validarRegistro({ peso_kg: '80', data: 'ontem' }, H).erro, 'Data inválida.', 'texto não é data');
  eq(p.validarRegistro({ peso_kg: '80', data: '1949-12-31' }, H).erro, 'Data inválida.', 'antes de 1950');
  eq(p.validarRegistro({ peso_kg: '80', data: '2026-11-10T00:00:00+00:00' }, H).data, '2026-11-10', 'timestamp vira o dia');
  for (const ruim of ['', 'abc', '0', '-5', '600', '1000', '80,555', null, NaN]) {
    eq(!!p.validarRegistro({ peso_kg: ruim }, H).erro, true, `peso inválido recusado: ${JSON.stringify(ruim)}`);
  }
  eq(p.validarRegistro({ peso_kg: '599,9' }, H).peso_kg, 599.9, 'abaixo de 600 passa (CHECK da tabela é < 600)');
  eq(p.validarRegistro({ peso_kg: 'x', observacao: 'a'.repeat(300) }, H).erro !== undefined, true, 'erro antes da obs');
  eq(p.validarRegistro({ peso_kg: '70', observacao: 'a'.repeat(300) }, H).observacao.length, 100, 'observação cortada em 100');

  console.log('§3 data falada');
  eq(p.dataDaFrase('hoje', H), H, 'hoje');
  eq(p.dataDaFrase('ontem', H), '2026-11-15', 'ontem');
  eq(p.dataDaFrase('anteontem', H), '2026-11-14', 'anteontem');
  eq(p.dataDaFrase('ontem', '2026-03-01'), '2026-02-28', 'ontem atravessa o mês');
  eq(p.dataDaFrase('dia 10', H), '2026-11-10', 'dia 10 já passou neste mês');
  eq(p.dataDaFrase('no dia 16', H), H, 'dia de hoje');
  eq(p.dataDaFrase('dia 28', H), '2026-10-28', 'dia 28 ainda não chegou → mês passado');
  eq(p.dataDaFrase('dia 31', '2026-12-05'), null, 'dia 31 em 05/12: 31/12 é futuro e 31/11 não existe');
  eq(p.dataDaFrase('dia 31', '2026-01-05'), '2025-12-31', 'dia 31 em 05/01: 31/01 é futuro → 31/12 do ano passado');
  eq(p.dataDaFrase('dia 28', '2026-01-05'), '2025-12-28', 'virada de ano');
  eq(p.dataDaFrase('10/11', H), '2026-11-10', 'dd/mm deste ano');
  eq(p.dataDaFrase('em 20/12', H), '2025-12-20', 'dd/mm que ainda não chegou → ano passado');
  eq(p.dataDaFrase('dia 10/11', H), '2026-11-10', '"dia 10/11"');
  eq(p.dataDaFrase('10/11/25', H), '2025-11-10', 'ano com 2 dígitos');
  eq(p.dataDaFrase('10/11/2025', H), '2025-11-10', 'ano com 4 dígitos');
  eq(p.dataDaFrase('10/12/2026', H), null, 'data completa no futuro');
  eq(p.dataDaFrase('31/02', H), null, 'não existe');
  eq(p.dataDaFrase('29/02', H), null, '29/02 sem ano em 2026: não existe em 2026 nem em 2025');
  eq(p.dataDaFrase('semana passada', H), null, 'não reconhecida');
  eq(p.dataDaFrase('', H), null, 'vazio');

  console.log('§4 comando do WhatsApp');
  eq(p.lerComandoPeso('peso 80'), { peso: '80', quando: null }, '"peso 80" sem kg (antes falhava)');
  eq(p.lerComandoPeso('peso 75.2'), { peso: '75.2', quando: null }, 'o exemplo da mensagem de erro funciona');
  eq(p.lerComandoPeso('Peso 80,5 kg'), { peso: '80,5', quando: null }, 'com kg e maiúscula');
  eq(p.lerComandoPeso('peso 80 ontem'), { peso: '80', quando: 'ontem' }, 'com ontem');
  eq(p.lerComandoPeso('peso 80kg dia 10'), { peso: '80', quando: 'dia 10' }, 'com dia');
  eq(p.lerComandoPeso('registrar peso 72,4 em 10/11'), { peso: '72,4', quando: 'em 10/11' }, 'com dd/mm');
  eq(p.lerComandoPeso('estou com 80kg ontem'), { peso: '80', quando: 'ontem' }, 'estou com + kg');
  eq(p.lerComandoPeso('tô com 79 quilos'), { peso: '79', quando: null }, 'tô com + quilos');
  eq(p.lerComandoPeso('estou com 80'), null, '"estou com 80" sem kg NÃO é peso');
  eq(p.lerComandoPeso('to com 80 reais'), null, 'dinheiro não é peso');
  eq(p.lerComandoPeso('peso 80 da caixa de som'), null, 'cauda que não é data não é capturada');
  eq(p.lerComandoPeso('qual meu peso'), null, 'pergunta não é registro');
  eq(p.lerComandoPeso('peso'), null, 'sem número');

  console.log('§5 rotas');
  await rotas();

  console.log(`\n${total - falhas.length}/${total} ok`);
  if (falhas.length) { console.log('\nFALHAS:\n - ' + falhas.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

// ── Banco falso + rotas reais ────────────────────────────────────────────────
function criarBanco(inicial, { falharLeitura = false } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = false, conflito = null;
    const api = {
      select() { return api; }, order() { return api; },
      update(x) { modo = 'update'; payload = x; return api; },
      upsert(x, o) { modo = 'upsert'; payload = x; conflito = o?.onConflict; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      gte(c, v) { filtros.push((r) => r[c] >= v); return api; },
      maybeSingle() { unica = true; return api; }, single() { unica = true; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
      if (falharLeitura && modo === 'select' && nome === 'pesos') return { data: null, error: { message: 'rede' } };
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'upsert') {
        const chaves = (conflito || '').split(',');
        let linha = t.find((r) => chaves.every((k) => r[k] === payload[k]));
        if (linha) Object.assign(linha, payload); else { linha = { id: `n${++seq}`, ...payload }; t.push(linha); }
        return { data: { ...linha }, error: null };
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      if (modo === 'delete') tabelas[nome] = t.filter((r) => !alvo.includes(r));
      const l = alvo.map((r) => ({ ...r }));
      return unica ? { data: l[0] || null, error: null } : { data: l, error: null };
    }
    return api;
  }
  return { tabelas, client: { from } };
}

function carregar(banco) {
  const raiz = path.join(__dirname, '..', 'src') + path.sep;
  const fixar = (rel, ex) => { const f = path.join(raiz, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: ex }; };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz) && !k.endsWith('pesoRegistro.js')) delete require.cache[k];
  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (q, s, n) => n());
  fixar('middlewares/permissao.js', { exigirPermissao: () => (q, s, n) => n() });
  fixar('services/nutricao.js', {});
  const router = require(path.join(raiz, 'routes/saude.js'));
  const h = (m, r) => {
    const l = router.stack.find((x) => x.route && x.route.path === r && x.route.methods[m]);
    return l.route.stack.map((s) => s.handle);
  };
  // ⚠️ O `requireGrow` chama `next()` sem `await`: a resposta só existe quando
  // alguém chama res.json — é por ela que se espera, não pela cadeia.
  const chamar = (m, r) => (req = {}, user = 'u1') => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve(this); return this; },
    };
    const r2 = { params: {}, query: {}, body: {}, authUser: { id: user }, ...req };
    const cadeia = h(m, r);
    let i = 0;
    const next = () => { const f = cadeia[i++]; if (f) Promise.resolve(f(r2, res, next)).catch(reject); };
    next();
  });
  return {
    listar: chamar('get', '/pesos/:phone'), criar: chamar('post', '/pesos'),
    editar: chamar('put', '/pesos/:id'), apagar: chamar('delete', '/pesos/:id'),
  };
}

async function rotas() {
  const hoje = p.hojeSP();
  const ontem = p.somarDias(hoje, -1);
  const cen = () => ({
    users: [{ id: 'u1', grupo_ativo: 'g1', plano: 'premium' }, { id: 'u2', grupo_ativo: 'g2', plano: 'premium' }],
    pesos: [
      { id: 'a', user_id: 'u1', grupo_id: 'g1', data: ontem, peso_kg: 80, observacao: null },
      { id: 'b', user_id: 'u1', grupo_id: 'g1', data: p.somarDias(hoje, -400), peso_kg: 90, observacao: null },
      { id: 'z', user_id: 'u2', grupo_id: 'g2', data: ontem, peso_kg: 60, observacao: null },
    ],
  });
  const peso = (b, id) => b.tabelas.pesos.find((x) => x.id === id);

  {
    const b = criarBanco(cen()); const r = carregar(b);
    const x = await r.criar({ body: { peso_kg: '79,4', data: p.somarDias(hoje, -5) } });
    eq([x.statusCode, x.body.peso_kg, x.body.data, x.body.substituiu], [200, 79.4, p.somarDias(hoje, -5), false], '§5 cria com a data escolhida');
    const y = await r.criar({ body: { peso_kg: '78' , data: ontem } });
    eq([y.statusCode, y.body.substituiu, peso(b, 'a').peso_kg], [200, true, 78], '§5 mesmo dia substitui e AVISA');
    eq((await r.criar({ body: { peso_kg: '78', data: p.somarDias(hoje, 1) } })).statusCode, 400, '§5 data futura → 400');
    eq((await r.criar({ body: { peso_kg: 'abc' } })).statusCode, 400, '§5 peso inválido → 400 (antes virava 500)');
    const z = await r.criar({ body: { peso_kg: '81' } });
    eq(z.body.data, hoje, '§5 sem data = hoje em SP');
  }
  {
    const b = criarBanco(cen()); const r = carregar(b);
    eq((await r.listar({ query: { dias: '30' } })).body.map((x) => x.id), ['a'], '§5 últimos 30 dias, só os meus');
    eq((await r.listar({ query: { dias: 'todos' } })).body.map((x) => x.id).sort(), ['a', 'b'], '§5 "todos" traz o histórico inteiro');
    eq((await carregar(criarBanco(cen(), { falharLeitura: true })).listar({ query: {} })).statusCode, 500, '§5 falha de leitura é erro, não lista vazia');
  }
  {
    const b = criarBanco(cen()); const r = carregar(b);
    const e = await r.editar({ params: { id: 'b' }, body: { peso_kg: '88,8', data: p.somarDias(hoje, -399), observacao: 'corrigido' } });
    eq([e.statusCode, peso(b, 'b').peso_kg, peso(b, 'b').observacao], [200, 88.8, 'corrigido'], '§5 edita peso, data e obs');
    const c = await r.editar({ params: { id: 'b' }, body: { peso_kg: '88', data: ontem } });
    eq([c.statusCode, peso(b, 'b').data], [409, p.somarDias(hoje, -399)], '§5 mudar pra um dia que já tem peso → 409, nada muda');
    eq((await r.editar({ params: { id: 'a' }, body: { peso_kg: '79', data: ontem } })).statusCode, 200, '§5 mesma data não colide consigo');
    eq((await r.editar({ params: { id: 'z' }, body: { peso_kg: '1', data: ontem } })).statusCode, 404, '§5 editar o de OUTRA pessoa → 404');
    eq(peso(b, 'z').peso_kg, 60, '§5 … e nada muda nele');
  }
  {
    const b = criarBanco(cen()); const r = carregar(b);
    eq((await r.apagar({ params: { id: 'z' } })).statusCode, 404, '§5 apagar o de OUTRA pessoa → 404');
    eq(!!peso(b, 'z'), true, '§5 … e ele continua lá (era o furo)');
    eq((await r.apagar({ params: { id: 'a' } })).statusCode, 200, '§5 apaga o próprio');
    eq(!!peso(b, 'a'), false, '§5 … e some');
  }
}
