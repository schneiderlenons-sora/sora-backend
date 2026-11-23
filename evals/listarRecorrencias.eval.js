// =============================================================================
// "Quais minhas receitas fixas?" — handlers/recorrencias.js (listar_recorrencias).
//
// Relato (nov/2026): respondia "nenhuma receita fixa cadastrada" com duas
// receitas fixas no painel. O handler consultava `tipo = 'Receita'`, e receita
// fixa é gravada como 'Recebimento'. Roda o HANDLER REAL com um banco falso e
// confere o texto que vai pro WhatsApp.
//
// Rodar: node evals/listarRecorrencias.eval.js
// =============================================================================
const Module = require('module');

const falhas = [];
let total = 0;
const ok = (c, msg) => { total += 1; if (!c) falhas.push(msg); };

const BASE = [
  { tipo: 'Recebimento', categoria: 'Salário', descricao: 'Salário', valor: 2151, dia_vencimento: 7, valor_variavel: false, ativa: true },
  { tipo: 'Recebimento', categoria: 'Salário', descricao: 'Vale do Salário', valor: 1960, dia_vencimento: 20, valor_variavel: false, ativa: true },
  { tipo: 'Gasto', categoria: 'Aluguel', descricao: 'Aluguel Quinto Andar', valor: 1077.91, dia_vencimento: 7, valor_variavel: false, ativa: true },
  { tipo: 'Gasto', categoria: 'Luz', descricao: 'Conta Luz', valor: 0, dia_vencimento: 28, valor_variavel: true, ativa: true },
  { tipo: 'Gasto', categoria: 'Academia', descricao: 'Inativa', valor: 89.9, dia_vencimento: 9, valor_variavel: false, ativa: false },
];

/** Roda listar_recorrencias com um filtro e devolve { texto, filtroTipo }. */
async function rodar(filtro, linhas = BASE) {
  const enviados = [];
  let filtroTipo = 'sem filtro';
  const fake = () => {
    const filtros = {};
    const q = {
      select() { return q; },
      eq(campo, valor) { filtros[campo] = valor; if (campo === 'tipo') filtroTipo = valor; return q; },
      order: async () => ({
        data: linhas.filter((r) => (filtros.ativa === undefined || r.ativa === filtros.ativa)
          && (filtros.tipo === undefined || r.tipo === filtros.tipo)),
        error: null,
      }),
    };
    return q;
  };
  const orig = Module._load;
  let handler;
  try {
    for (const k of Object.keys(require.cache)) if (/sora-backend[\\/]src[\\/]/.test(k)) delete require.cache[k];
    Module._load = function (req) {
      if (req.endsWith('db/supabase')) return { from: fake };
      if (req.endsWith('services/mensageiro')) return { enviarTexto: async (_p, t) => { enviados.push(t); } };
      if (req.endsWith('services/moeda')) {
        return { normalizarMoeda: (m) => m, taxasParaBase: async () => ({}), moedaBaseDoGrupo: async () => 'BRL', camposTransacao: () => ({}), formatar: (v) => `R$ ${v}` };
      }
      return orig.apply(this, arguments);
    };
    handler = require('../src/handlers/recorrencias');
  } finally { Module._load = orig; }
  await handler({ acao: 'listar_recorrencias', filtro }, { phone: '5500', grupoId: 'g1', user: {} });
  return { texto: enviados.join('\n---\n'), filtroTipo };
}

(async () => {
  // ── 1. O relato: receitas fixas aparecem.
  let r = await rodar('Receita');
  ok(r.filtroTipo === 'Recebimento', `1. consulta pelo tipo gravado no banco ('Recebimento'), veio '${r.filtroTipo}'`);
  ok(/Suas receitas fixas do mês/.test(r.texto), '1. título de receitas fixas');
  ok(/Salário — dia 07/.test(r.texto) && /Vale do Salário — dia 20/.test(r.texto), '1. lista as duas receitas fixas');
  ok(!/nenhuma receita fixa/.test(r.texto), '1. não diz mais "nenhuma"');
  ok(!/Aluguel/.test(r.texto), '1. não mistura gasto fixo');
  ok(/💰 \*R\$\s?2\.151,00\*/.test(r.texto), '1. receita com ícone de receita e valor');
  ok(/Todo mês entra R\$\s?4\.111,00/.test(r.texto), `1. total que entra (veio: ${r.texto.split('\n').filter((l) => /Todo mês/.test(l))})`);
  ok(!/sai R\$/.test(r.texto), '1. sem "sai" numa lista só de receitas');

  // ── 2. Gastos fixos: igual a antes.
  r = await rodar('Gasto');
  ok(r.filtroTipo === 'Gasto', '2. gastos consultam tipo Gasto');
  ok(/Seus gastos fixos do mês/.test(r.texto) && /Aluguel Quinto Andar/.test(r.texto), '2. lista os gastos fixos');
  ok(!/Salário/.test(r.texto), '2. não mistura receita');
  ok(/Todo mês sai R\$\s?1\.077,91, mais 1 conta de valor variável\./.test(r.texto), '2. total e a conta variável como antes');
  ok(/_valor varia_/.test(r.texto), '2. variável sem número inventado');
  ok(!/Inativa/.test(r.texto), '2. recorrência inativa não entra');

  // ── 3. Tudo junto: receita com ícone de receita, os dois totais e a sobra.
  r = await rodar(null);
  ok(r.filtroTipo === 'sem filtro', '3. sem filtro de tipo');
  ok(/💰 \*R\$\s?1\.960,00\* · Vale do Salário/.test(r.texto), '3. receita aparece com 💰 (era 💸)');
  ok(/💸 \*R\$\s?1\.077,91\* · Aluguel/.test(r.texto), '3. gasto segue com 💸');
  ok(/sai R\$\s?1\.077,91 e entra R\$\s?4\.111,00/.test(r.texto), '3. "entra" passa a contar as receitas');
  ok(/Sobram R\$\s?3\.033,09 depois das fixas\./.test(r.texto), '3. a sobra aparece (só existe com os dois lados)');

  // ── 4. Sem receitas cadastradas: a mensagem, agora com o "não".
  r = await rodar('Receita', BASE.filter((x) => x.tipo === 'Gasto'));
  ok(/Você não tem nenhuma receita fixa cadastrada\./.test(r.texto), '4. vazio diz "Você não tem nenhuma receita fixa"');
  r = await rodar('Gasto', []);
  ok(/Você não tem nenhum gasto fixo cadastrado\./.test(r.texto), '4. vazio de gastos também');

  // ── 5. Linha legada com tipo 'Receita' (se existir) ainda é lida como receita.
  r = await rodar(null, [{ tipo: 'Receita', descricao: 'Legado', valor: 100, dia_vencimento: 10, ativa: true }]);
  ok(/💰 \*R\$\s?100,00\* · Legado/.test(r.texto) && /entra R\$\s?100,00/.test(r.texto), '5. tipo antigo "Receita" segue como receita');

  if (falhas.length) {
    console.error(`\n❌ ${falhas.length} de ${total} falharam:`);
    for (const f of falhas) console.error('  ·', f);
    process.exit(1);
  }
  console.log(`✅ listar recorrências: ${total} verificações ok`);
})();
