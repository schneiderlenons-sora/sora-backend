// =============================================================================
// EVAL da autoria nas listas (Fase 5 — parte pura).
//
// É display, mas tem dois jeitos de estragar: (1) quebrar a lista quando falta
// o autor (lançamento antigo sem user_id), (2) vazar o id cru no lugar do nome.
// Rodar: npm run eval:autor-negocio
// =============================================================================
const { aplicarAutor } = require('../src/services/autorNegocio');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const mapa = { u1: 'Maria', u2: 'João' };

console.log('── 1. anexa o nome ──');
{
  const r = aplicarAutor([{ id: 'a', user_id: 'u1', valor: 10 }, { id: 'b', user_id: 'u2' }], mapa);
  ok(r[0].criado_por_nome === 'Maria', 'u1 → Maria');
  ok(r[1].criado_por_nome === 'João', 'u2 → João');
  ok(r[0].valor === 10 && r[0].id === 'a', 'preserva os outros campos da linha');
}
console.log('  ok');

console.log('── 2. sem autor → null (não quebra, não vaza id) ──');
{
  const r = aplicarAutor([{ id: 'a', user_id: null }, { id: 'b' }, { id: 'c', user_id: 'desconhecido' }], mapa);
  ok(r[0].criado_por_nome === null, 'user_id null → null');
  ok(r[1].criado_por_nome === null, 'sem o campo → null');
  ok(r[2].criado_por_nome === null, 'id fora do mapa → null (NUNCA mostra o uuid cru)');
}
console.log('  ok');

console.log('── 3. bordas ──');
{
  ok(Array.isArray(aplicarAutor(null, mapa)) && aplicarAutor(null, mapa).length === 0, 'rows null → []');
  ok(aplicarAutor([{ id: 'a', user_id: 'u1' }], null)[0].criado_por_nome === null, 'mapa null → null, sem crashar');
  // campo alternativo
  ok(aplicarAutor([{ id: 'a', autor: 'u2' }], mapa, 'autor')[0].criado_por_nome === 'João', 'respeita o campo informado');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) { console.log('\n── Falhas ──'); falhas.forEach((f) => console.log(`  ${f}`)); process.exit(1); }
