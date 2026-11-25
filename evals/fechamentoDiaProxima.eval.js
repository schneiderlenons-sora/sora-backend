// =============================================================================
// EVAL: a opção "compra no dia do fechamento vai pra PRÓXIMA fatura" chega a
// TODOS os lugares que calculam fatura (migration 200).
//
// A regra mora em services/cicloFatura.js (eval:ciclo §9) e decide pelo CARTÃO
// (`fechamento_dia_proxima` + `of_conta_id`). O risco não está na regra, está
// em quem a chama: uma consulta que lê o cartão SEM essas colunas calcula a
// fatura pela regra antiga — e a mesma fatura sai com um valor numa tela e
// outro em outra (o "zap × painel" que este projeto já pagou caro).
//
// O que este eval trava, lendo o CÓDIGO:
//   1. toda consulta de carteira que lê `dia_fechamento` lê também
//      `fechamento_dia_proxima` e `of_conta_id` (a cópia de grupo é exceção:
//      ela cria carteiras manuais, sem vínculo com o banco);
//   2. ninguém usa `ciclo.fim` como limite de "já fechou / depois do
//      fechamento" com < ou >: com a opção, o último dia da fatura é a VÉSPERA
//      do fechamento — use `ultimo` (ou `fimExcl`).
//
// Rodar:  npm run eval:fechamento-dia-proxima
// =============================================================================
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '../src');
const andar = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? andar(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);

const falhas = [];
let consultas = 0, comparacoes = 0;
for (const f of andar(RAIZ)) {
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
  const s = fs.readFileSync(f, 'utf8');

  // 1. consultas de carteira que leem o dia de fechamento
  for (const m of s.matchAll(/select\((['`])([^'`]*dia_fechamento[^'`]*)\1/g)) {
    consultas++;
    const cols = m[2].split(',').map((c) => c.trim());
    if (!cols.includes('fechamento_dia_proxima')) falhas.push(`${rel}: consulta lê dia_fechamento sem fechamento_dia_proxima → "${m[2]}"`);
    if (!cols.includes('of_conta_id') && rel !== 'services/copiarGrupo.js') falhas.push(`${rel}: consulta lê dia_fechamento sem of_conta_id → "${m[2]}"`);
  }

  // 2. `ciclo.fim` comparado com < ou > fora do próprio módulo do ciclo
  if (rel === 'services/cicloFatura.js') continue;
  s.split(/\r?\n/).forEach((linha, i) => {
    if (/^\s*(\/\/|\*)/.test(linha)) return;
    const usa = /\b(ciclo|cicloAnterior|st\.ciclo)\.fim\b(?!Excl|Ciclo)/.test(linha);
    if (!usa) return;
    if (/\b(ciclo|cicloAnterior|st\.ciclo)\.fim\b(?!Excl)\s*[<>]|[<>]=?\s*\(?\s*(ciclo|cicloAnterior|st\.ciclo)\.fim\b(?!Excl)/.test(linha)) {
      comparacoes++;
      if (!/ultimo/.test(linha)) falhas.push(`${rel}:${i + 1}: compara ciclo.fim com < ou > (use ciclo.ultimo || ciclo.fim) → ${linha.trim()}`);
    }
  });
}

console.log(`── consultas de carteira com dia_fechamento: ${consultas}`);
console.log(`── comparações de ciclo.fim encontradas: ${comparacoes}`);
if (consultas < 15) falhas.push(`esperava achar ao menos 15 consultas com dia_fechamento, achei ${consultas} (o regex quebrou?)`);
if (falhas.length) {
  console.error(`\n✗ ${falhas.length} falha(s):\n  - ` + falhas.join('\n  - '));
  process.exit(1);
}
console.log('\n✓ eval:fechamento-dia-proxima ok');
