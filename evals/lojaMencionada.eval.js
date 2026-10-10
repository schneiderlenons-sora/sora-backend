// =============================================================================
// EVAL — qual loja a frase citou (Fase 4, parte pura).
//
// O risco é escolher a loja ERRADA (sumiria a venda da loja certa) ou casar por
// acaso. Na dúvida tem de devolver null (cai no comportamento de hoje, que não
// recusa a venda). Rodar: npm run eval:loja-mencionada
// =============================================================================
const { acharLojaNaFrase } = require('../src/services/lojaMencionada');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const E = (id, nome) => ({ id, nome });
const LOJAS = [E('a', 'Centro'), E('b', 'Shopping'), E('c', 'Bairro Norte')];

console.log('── 1. cita uma loja → escolhe ──');
ok(acharLojaNaFrase('vendi 3 bolos na loja Centro pra dona Maria', LOJAS)?.id === 'a', 'cita Centro');
ok(acharLojaNaFrase('vendi 2 cafés no Shopping', LOJAS)?.id === 'b', 'cita Shopping');
ok(acharLojaNaFrase('vendi 1 pão no bairro norte por 5', LOJAS)?.id === 'c', 'cita nome com espaço');
ok(acharLojaNaFrase('VENDI NA CENTRO', LOJAS)?.id === 'a', 'ignora caixa');
// ⚠️ nome COM acento × frase SEM: só casa se o norm tira o diacrítico dos dois.
ok(acharLojaNaFrase('vendi no jardim botanico', [E('a', 'Jardim Botânico'), E('b', 'Centro')])?.id === 'a',
  'nome acentuado ("Botânico") casa com frase sem acento ("botanico")');

console.log('── 2. não cita nenhuma → null ──');
ok(acharLojaNaFrase('vendi 3 bolos por 90 pra dona Maria', LOJAS) === null, 'sem loja na frase');
ok(acharLojaNaFrase('', LOJAS) === null, 'frase vazia');

console.log('── 3. com 1 loja só não há o que escolher ──');
ok(acharLojaNaFrase('vendi na Centro', [E('a', 'Centro')]) === null, '1 empresa → null (quem chama usa essa)');

console.log('── 4. não casa por ACASO ──');
ok(acharLojaNaFrase('comprei um centrofone', LOJAS) === null, 'substring sem fronteira não casa (centrofone ≠ Centro)');
ok(acharLojaNaFrase('vendi na loja', [E('a', 'Loja'), E('b', 'Shopping')])?.id === 'a', 'loja chamada "Loja" citada como "na loja" casa (é o nome real)');

console.log('── 5. ambiguidade real → null; específica vence ──');
{
  const dois = [E('a', 'Centro'), E('b', 'Centro Sul')];
  ok(acharLojaNaFrase('vendi na centro sul', dois)?.id === 'b', 'a mais específica vence (Centro ⊂ Centro Sul)');
  const diferentes = [E('a', 'Centro'), E('b', 'Shopping')];
  ok(acharLojaNaFrase('mandei do centro pro shopping', diferentes) === null, 'duas lojas diferentes citadas → ambíguo → null');
}

console.log('── 6. nome < 3 letras é ignorado ──');
ok(acharLojaNaFrase('vendi na pb hoje', [E('a', 'PB'), E('b', 'Shopping')]) === null, 'loja de 2 letras não casa (acaso demais)');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) { console.log('\n── Falhas ──'); falhas.forEach((f) => console.log(`  ${f}`)); process.exit(1); }
