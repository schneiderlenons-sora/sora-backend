// =============================================================================
// BACKFILL: recorrências apontando pra categoria que NÃO EXISTE MAIS.
//
// CAUSA: o rebuild de categorias (migrations 084→087) renomeou a taxonomia e
// REMAPEOU as `transacoes`, mas não as `recorrencias`. Somado a isso,
// services/recorrencias.js tinha '💼 Salário' hardcoded como padrão de receita
// — nome que deixou de existir (hoje é 'Salário').
//
// SINTOMA que o usuário relatou: "a edição de categoria dos gastos fixos não
// salva e eles voltam pra Outros". A edição salvava; o que estava errado era o
// template apontar pra um nome fantasma. Quando o cron lançava a transação,
// ela carregava esse nome, a aba Categorias não achava no catálogo do grupo e
// jogava em "Outros".
//
// Medido antes: 56 de 189 recorrências ativas com categoria órfã (30 só de
// '💼 Salário').
//
// Como remapeia (nesta ordem, sempre DENTRO do grupo da recorrência):
//   1. nome idêntico;
//   2. sem o emoji do começo ("💼 Salário" → "Salário");
//   3. comparação frouxa (sem acento/caixa/pontuação);
//   4. não achou → NÃO MEXE. Deixa como está em vez de chutar "Outros", que
//      apagaria a intenção do usuário.
//
// Uso:
//   node scripts/backfill-categorias-recorrencias.js           # simulação
//   node scripts/backfill-categorias-recorrencias.js --apply   # grava
// =============================================================================
require('dotenv').config();
const supabase = require('../src/db/supabase');

const APLICAR = process.argv.includes('--apply');

/** Tira emoji/símbolo do começo do nome. */
const semEmoji = (s) => String(s || '')
  .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\s]+/u, '')
  .trim();

/** Chave frouxa: sem acento, sem caixa, sem pontuação. */
const frouxa = (s) => semEmoji(s)
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

async function tudo(tabela, colunas) {
  const out = [];
  for (let from = 0; ; from += 1000) {   // o Supabase corta em 1000 sem avisar
    const { data, error } = await supabase.from(tabela).select(colunas).order('id').range(from, from + 999);
    if (error) { console.error(`erro lendo ${tabela}:`, error.message); process.exit(1); }
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  console.log(APLICAR ? '⚠️  MODO GRAVAÇÃO' : '🔍 SIMULAÇÃO (nada será gravado)', '\n');

  const cats = await tudo('categorias', 'nome, grupo_id, tipo');
  const recs = (await tudo('recorrencias', 'id, grupo_id, tipo, categoria, descricao, ativa'))
    .filter((r) => r.ativa);

  // Índices por grupo: exato · sem emoji · frouxo.
  const porGrupo = new Map();
  for (const c of cats) {
    if (!porGrupo.has(c.grupo_id)) porGrupo.set(c.grupo_id, { exato: new Map(), sem: new Map(), fx: new Map() });
    const ix = porGrupo.get(c.grupo_id);
    if (!ix.exato.has(c.nome))        ix.exato.set(c.nome, c.nome);
    if (!ix.sem.has(semEmoji(c.nome))) ix.sem.set(semEmoji(c.nome), c.nome);
    if (!ix.fx.has(frouxa(c.nome)))    ix.fx.set(frouxa(c.nome), c.nome);
  }

  const consertar = []; const semSaida = [];
  for (const r of recs) {
    const atual = r.categoria;
    if (!atual) continue;
    const ix = porGrupo.get(r.grupo_id);
    if (!ix) continue;                       // grupo sem catálogo: não inventa
    if (ix.exato.has(atual)) continue;       // já está certa

    const novo = ix.sem.get(semEmoji(atual)) || ix.fx.get(frouxa(atual)) || null;
    if (novo && novo !== atual) consertar.push({ ...r, novo });
    else if (!novo) semSaida.push(r);
  }

  const porPar = new Map();
  for (const c of consertar) {
    const k = `${c.categoria} → ${c.novo}`;
    porPar.set(k, (porPar.get(k) || 0) + 1);
  }

  console.log('recorrências ativas .........', recs.length);
  console.log('categoria órfã CORRIGÍVEL ...', consertar.length);
  console.log('órfã SEM equivalente (não mexo)', semSaida.length, '\n');

  console.log('remapeamentos:');
  [...porPar].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${String(n).padStart(3)}×  ${k}`));

  if (semSaida.length) {
    console.log('\nsem equivalente no grupo (ficam como estão):');
    const u = new Map();
    semSaida.forEach((r) => u.set(r.categoria, (u.get(r.categoria) || 0) + 1));
    [...u].forEach(([c, n]) => console.log(`   ${String(n).padStart(3)}×  ${c}`));
  }

  if (!APLICAR) { console.log('\nSimulação. Rode com --apply pra gravar.'); return; }

  console.log('\ngravando...');
  let ok = 0; let erros = 0;
  for (const c of consertar) {
    const { error } = await supabase.from('recorrencias')
      .update({ categoria: c.novo }).eq('id', c.id);
    if (error) { erros++; if (erros <= 3) console.error('  erro em', c.id, error.message); }
    else ok++;
  }
  console.log(`atualizadas: ${ok} · erros: ${erros}`);
})();
