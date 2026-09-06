const fs = require('fs');
const p = 'src/handlers/transacoes.js';
let t = fs.readFileSync(p, 'utf8');
const antes = t;

// 1. o select precisa das colunas do ciclo (id, of_conta_id, dia_fechamento…).
//    '*' de proposito: coluna de migration nao rodada derruba um select por NOME
//    inteiro, e o resumo sumiria (mesma licao do `nos_previstos` em wallets.js).
t = t.replace(
  "const { data } = await supabase.from('wallets').select('nome, tipo, saldo').eq('grupo_id', grupoId);",
  "const { data } = await supabase.from('wallets').select('*').eq('grupo_id', grupoId);");

// 2. o bloco do patrimonio passa a usar a fonte unica.
const velho = `      const rc = somarSaldosTx(ws.filter(w => w.tipo !== 'Crédito'), tabela);
      const rk = somarSaldosTx(ws.filter(w => w.tipo === 'Crédito'), tabela);
      const emContas  = rc.total;
      const saldoCard = rk.total;   // negativo = a pagar
      const aPagar    = saldoCard < 0 ? -saldoCard : 0;
      // ⚠️ Total parcial tem de se declarar parcial — mesmo aviso de wallets.js.
      const faltando = rc.semCambio + rk.semCambio;
      const aviso = faltando > 0 ? \`\n⚠️ \${faltando} conta(s) fora: câmbio indisponível.\` : '';
      blocoPatrimonio = (aPagar > 0
        ? \`\n\n🏦 Em contas: R$ \${emContas.toFixed(2)}\n💳 A pagar no cartão: R$ \${aPagar.toFixed(2)}\n💰 *Saldo real: R$ \${(emContas + saldoCard).toFixed(2)}*\`
        : \`\n\n🏦 *Saldo em contas: R$ \${emContas.toFixed(2)}*\`) + aviso;`;

const novo = `      const rc = somarSaldosTx(ws.filter(w => w.tipo !== 'Crédito'), tabela);
      const emContas = rc.total;

      // ⚠️ O CARTÃO NÃO SAI DE \`−saldo\`. Isso somava a fatura BRUTA (sem
      // descontar \`pagamentos_fatura\`) e, no cartão manual, o saldo ACUMULADO
      // em vez da fatura do ciclo — o zap dizia "a pagar R$ 3.663,42" com o
      // painel mostrando R$ 1.041,05 no mesmo minuto. Ver services/aPagarCartoes.js.
      const rk = await aPagarCartoes(grupoId, ws, tabela);
      const aPagar = rk.total;

      // ⚠️ Total parcial tem de se declarar parcial — mesmo aviso de wallets.js.
      const aviso = avisoParcialCartoes({ semCambio: rc.semCambio + rk.semCambio, semFatura: rk.semFatura });
      blocoPatrimonio = (aPagar > 0
        ? \`\n\n🏦 Em contas: R$ \${emContas.toFixed(2)}\n💳 A pagar no cartão: R$ \${aPagar.toFixed(2)}\n💰 *Saldo real: R$ \${(emContas - aPagar).toFixed(2)}*\`
        : \`\n\n🏦 *Saldo em contas: R$ \${emContas.toFixed(2)}*\`) + aviso;`;

if (!t.includes(velho)) throw new Error('bloco do patrimonio nao encontrado');
t = t.replace(velho, novo);

// 3. import
const ancora = "  somarSaldos: somarSaldosTx,";
if (!t.includes(ancora)) throw new Error('ancora do import nao encontrada');
t = t.replace(ancora, ancora + "\n};\nconst {\n  aPagarCartoes,\n  avisoParcial: avisoParcialCartoes,");

if (t === antes) throw new Error('nada mudou');
fs.writeFileSync(p, t);
console.log('patch aplicado');
