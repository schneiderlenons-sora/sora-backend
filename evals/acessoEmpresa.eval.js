// =============================================================================
// EVAL do acesso à empresa (services/acessoEmpresa) — Negócios multiusuário.
//
// Isto é CONTROLE DE ACESSO: o erro aqui não aparece como número errado na
// tela, aparece como o financeiro de uma loja enxergando (ou editando) o caixa
// de outra — ou como um dono perdendo a própria empresa. Por isso cada regra
// tem caso positivo E negativo, e a degradação é testada com o banco falhando
// de verdade.
//
// Rodar:  npm run eval:acesso-empresa
// =============================================================================
const path = require('path');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(
  JSON.stringify(a) === JSON.stringify(b),
  `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`,
);

// ── Banco falso ────────────────────────────────────────────────────────────
// `falhar` derruba UMA tabela (rejeição real da consulta), pra exercitar a
// degradação de cada lado separadamente.
function bancoFake({ empresas = [], empresa_membros = [], falhar = null } = {}) {
  const tabelas = { empresas, empresa_membros };
  return {
    from(nome) {
      const filtros = [];
      const api = {
        select() { return api; },
        eq(c, v) { filtros.push((r) => r[c] === v); return api; },
        order() { return api; },
        maybeSingle() {
          if (falhar === nome) return Promise.resolve({ data: null, error: new Error('falha de leitura') });
          const linhas = (tabelas[nome] || []).filter((r) => filtros.every((f) => f(r)));
          return Promise.resolve({ data: linhas[0] || null });
        },
        then(res) {
          if (falhar === nome) return Promise.resolve(res({ data: null, error: new Error('falha de leitura') }));
          const linhas = (tabelas[nome] || []).filter((r) => filtros.every((f) => f(r)));
          // O vínculo vem com a empresa embutida (o join do service).
          const data = nome === 'empresa_membros'
            ? linhas.map((v) => ({ ...v, empresas: empresas.find((e) => e.id === v.empresa_id) || null }))
            : linhas;
          return Promise.resolve(res({ data }));
        },
      };
      return api;
    },
  };
}

function carregar(banco) {
  const raiz = path.resolve(__dirname, '../src');
  const f = path.join(raiz, 'db/supabase.js');
  require.cache[f] = { id: f, filename: f, loaded: true, exports: banco };
  const alvo = path.join(raiz, 'services/acessoEmpresa.js');
  delete require.cache[alvo];
  return require(alvo);
}

// ── Cenário: o caso real do cliente ────────────────────────────────────────
// Dono com 2 lojas; um gerente só na segunda; um contador só de leitura.
const DONO = 'u-dono', GERENTE = 'u-gerente', CONTADOR = 'u-contador', ESTRANHO = 'u-estranho';
const LOJA_A = { id: 'e-a', nome: 'IM PELOTAS', tipo: 'fisico', ativa: true, user_id: DONO };
const LOJA_B = { id: 'e-b', nome: 'IM BAGÉ',    tipo: 'fisico', ativa: true, user_id: DONO };

const CENARIO = {
  empresas: [LOJA_A, LOJA_B],
  empresa_membros: [
    { empresa_id: 'e-a', user_id: DONO,     papel: 'admin',    padrao: false },
    { empresa_id: 'e-b', user_id: DONO,     papel: 'admin',    padrao: false },
    { empresa_id: 'e-b', user_id: GERENTE,  papel: 'operador', padrao: true  },
    { empresa_id: 'e-a', user_id: CONTADOR, papel: 'leitura',  padrao: false },
  ],
};

// ── 1. Quem alcança o quê ──────────────────────────────────────────────────
console.log('── 1. quem alcança o quê ──');
{
  const s = carregar(bancoFake(CENARIO));
  return (async () => {
    const dono = await s.empresasDoUsuario(DONO);
    eq(dono.map((e) => e.id).sort(), ['e-a', 'e-b'], 'dono alcança as duas lojas');
    eq(dono.every((e) => e.papel === 'admin'), true, 'dono é admin nas duas');

    // ⚠️ O CASO QUE JUSTIFICA O DESENHO: gerente de uma loja NÃO vê a rede.
    const ger = await s.empresasDoUsuario(GERENTE);
    eq(ger.map((e) => e.id), ['e-b'], 'gerente alcança SÓ a loja dele');
    eq(ger[0].papel, 'operador', 'gerente é operador');
    eq(ger[0].dono, false, 'gerente não é dono');

    const cont = await s.empresasDoUsuario(CONTADOR);
    eq(cont.map((e) => e.id), ['e-a'], 'contador alcança só onde foi convidado');
    eq(cont[0].papel, 'leitura', 'contador é leitura');

    eq(await s.empresasDoUsuario(ESTRANHO), [], 'quem não foi convidado não alcança nada');
    eq(await s.empresasDoUsuario(null), [], 'sem usuário não alcança nada');
    console.log('  ok');

    // ── 2. Papel numa empresa específica (o guard do IDOR) ────────────────
    console.log('── 2. papel por empresa ──');
    eq(await s.papelNaEmpresa(DONO, 'e-a'), 'admin', 'dono é admin');
    eq(await s.papelNaEmpresa(GERENTE, 'e-b'), 'operador', 'gerente na loja dele');
    // ⚠️ O NEGATIVO É O QUE IMPORTA: com o id da OUTRA loja, nada.
    eq(await s.papelNaEmpresa(GERENTE, 'e-a'), null, 'gerente NÃO alcança a outra loja');
    eq(await s.papelNaEmpresa(ESTRANHO, 'e-a'), null, 'estranho não alcança');
    eq(await s.papelNaEmpresa(DONO, 'e-inexistente'), null, 'empresa que não existe');
    eq(await s.papelNaEmpresa(null, 'e-a'), null, 'sem usuário');
    eq(await s.papelNaEmpresa(DONO, null), null, 'sem empresa');
    console.log('  ok');

    // ── 3. Hierarquia de papéis ───────────────────────────────────────────
    console.log('── 3. o papel basta? ──');
    eq(s.papelPermite('admin', 'operador'), true, 'admin cobre operador');
    eq(s.papelPermite('operador', 'operador'), true, 'operador cobre operador');
    // ⚠️ O contador NÃO pode lançar. É o ponto do papel existir.
    eq(s.papelPermite('leitura', 'operador'), false, 'leitura NÃO lança');
    eq(s.papelPermite('operador', 'admin'), false, 'operador não administra');
    eq(s.papelPermite('leitura', 'leitura'), true, 'leitura vê');
    eq(s.papelPermite(null, 'leitura'), false, 'sem papel não vê');
    eq(s.papelPermite('inventado', 'leitura'), false, 'papel desconhecido não vale');
    eq(await s.podeNaEmpresa(CONTADOR, 'e-a', 'leitura'), true, 'contador lê');
    eq(await s.podeNaEmpresa(CONTADOR, 'e-a', 'operador'), false, 'contador não lança');
    console.log('  ok');

    // ── 4. ⚠️ O DONO NUNCA PERDE A PRÓPRIA EMPRESA ────────────────────────
    //
    // Medido em 24/09/2026: 9 das 32 empresas ativas têm `grupo_id` diferente
    // do grupo atual do dono. Qualquer desenho que SUBSTITUA o dono pelo
    // vínculo as faz sumir de quem as criou. Aqui: empresa SEM linha nenhuma
    // em empresa_membros (backfill falhou / linha nasceu sem vínculo).
    console.log('── 4. o dono nunca perde a empresa ──');
    {
      const semBackfill = carregar(bancoFake({ empresas: [LOJA_A], empresa_membros: [] }));
      const r = await semBackfill.empresasDoUsuario(DONO);
      eq(r.map((e) => e.id), ['e-a'], 'sem vínculo nenhum, o dono ainda alcança');
      eq(r[0].papel, 'admin', 'e continua admin');
      eq(await semBackfill.papelNaEmpresa(DONO, 'e-a'), 'admin', 'papel do dono não depende da 173');

      // ⚠️ E não pode ser REBAIXADO por um vínculo gravado errado.
      const rebaixado = carregar(bancoFake({
        empresas: [LOJA_A],
        empresa_membros: [{ empresa_id: 'e-a', user_id: DONO, papel: 'leitura', padrao: false }],
      }));
      const r2 = await rebaixado.empresasDoUsuario(DONO);
      eq(r2[0].papel, 'admin', 'vínculo "leitura" não rebaixa o dono');
    }
    console.log('  ok');

    // ── 5. ⚠️ DEGRADAÇÃO ASSIMÉTRICA ──────────────────────────────────────
    //
    // Ler é tolerante (cair pro comportamento de hoje), mas PERMITIR nunca é.
    console.log('── 5. o que acontece quando o banco falha ──');
    {
      const semVinculos = carregar(bancoFake({ ...CENARIO, falhar: 'empresa_membros' }));
      const r = await semVinculos.empresasDoUsuario(DONO);
      eq(r.map((e) => e.id).sort(), ['e-a', 'e-b'], 'falha nos vínculos → dono mantém as dele');
      const g = await semVinculos.empresasDoUsuario(GERENTE);
      eq(g, [], 'falha nos vínculos → gerente não ganha nada que não é dele');

      // ⚠️ AQUI ESTÁ A REGRA QUE NÃO PODE INVERTER: falha de leitura não vira
      // permissão. Degradar pro lado de PERMITIR transformaria um soluço de
      // rede em brecha de acesso.
      eq(await semVinculos.papelNaEmpresa(GERENTE, 'e-b'), null, 'falha ao ler o vínculo NEGA');
      eq(await semVinculos.papelNaEmpresa(DONO, 'e-a'), 'admin', 'mas o dono passa (não depende do vínculo)');
    }
    console.log('  ok');

    // ── 6. Empresa inativa não conta ──────────────────────────────────────
    console.log('── 6. empresa arquivada ──');
    {
      const morta = { ...LOJA_B, ativa: false };
      const s2 = carregar(bancoFake({
        empresas: [LOJA_A, morta],
        empresa_membros: [{ empresa_id: 'e-b', user_id: GERENTE, papel: 'operador', padrao: true }],
      }));
      eq(await s2.empresasDoUsuario(GERENTE), [], 'empresa inativa some da lista');
      eq(await s2.papelNaEmpresa(GERENTE, 'e-b'), null, 'e não dá papel nenhum');

      // ⚠️ VALE PRO DONO TAMBÉM. Este caso nasceu de uma mutação SOBREVIVENTE:
      // tirar o `.eq('ativa', true)` do ramo do dono não quebrava nada, porque
      // o eval só testava o convidado. Arquivar a empresa tem de tirá-la da
      // lista de quem a criou também — senão ela volta pro seletor.
      const soArquivada = carregar(bancoFake({
        empresas: [{ ...LOJA_A, ativa: false }],
        empresa_membros: [],
      }));
      eq(await soArquivada.empresasDoUsuario(DONO), [], 'empresa arquivada some pro DONO também');
      eq(await soArquivada.papelNaEmpresa(DONO, 'e-a'), null, 'e o dono não tem papel nela');
    }
    console.log('  ok');

    // ── 7. ⚠️ QUAL EMPRESA A SORA ASSUME NO WHATSAPP ──────────────────────
    //
    // Hoje o handler faz `.order('created_at').limit(1)`. Numa rede de 6 lojas
    // isso lança a venda na loja ERRADA em silêncio — pior que não lançar.
    console.log('── 7. empresa assumida (WhatsApp) ──');
    {
      const uma = [{ id: 'e-a', ativa: true }];
      eq(s.empresaAssumida(uma).id, 'e-a', 'com UMA empresa, assume ela');

      const duas = [{ id: 'e-a', ativa: true }, { id: 'e-b', ativa: true }];
      eq(s.empresaAssumida(duas), null, 'com DUAS e nenhuma padrão, NÃO adivinha');

      const comPadrao = [{ id: 'e-a', ativa: true }, { id: 'e-b', ativa: true, padrao: true }];
      eq(s.empresaAssumida(comPadrao).id, 'e-b', 'respeita a marcada como padrão');

      // A inativa não pode virar a "única" e ser assumida por acidente.
      const umaViva = [{ id: 'e-a', ativa: true }, { id: 'e-b', ativa: false }];
      eq(s.empresaAssumida(umaViva).id, 'e-a', 'inativa não conta pro desempate');
      eq(s.empresaAssumida([]), null, 'sem empresa, null');
      eq(s.empresaAssumida(null), null, 'lista nula, null');
    }
    console.log('  ok');

    console.log('');
    if (falhas.length) {
      console.error(`✗ ${falhas.length} falha(s):`);
      falhas.forEach((f) => console.error('  ·', f));
      process.exit(1);
    }
    console.log('✓ acesso à empresa: todos os casos passaram');
  })();
}
