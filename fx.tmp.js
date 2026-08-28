const fs = require('fs');
const f = 'src/services/compraTexto.js';
let s = fs.readFileSync(f, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n'; const J = (a) => a.join(nl);

const de = J([
    "    const ehParcela = /\b\d{1,2}\s*x\s*(?:de|a)\s*(?:r\$)?\s*[\d.,]+/.test(t)",
    "      || /\b(?:parcelas?|presta[çc][õo]es?)\s+de\s+(?:r\$)?\s*[\d.,]+/.test(t)",
    "      || /\b(?:em|de)\s+\d{1,2}\s*(?:vezes|parcelas|meses)\s+de\s+(?:r\$)?\s*[\d.,]+/.test(t);",
]);
const para = J([
    "    // ⚠️ O nº de parcelas pode vir em dígito (\"10x\", \"em 10 vezes\") OU por",
    "    // extenso (\"em dez vezes\"). O teste tem de cobrir os dois: cobrindo só",
    "    // dígito, \"em dez vezes de 300\" lia o 300 como TOTAL e devolvia R$ 300",
    "    // no lugar de R$ 3.000 — errando o valor da compra por 10x.",
    "    const QTD = '(?:\\d{1,2}|' + Object.keys(PARCELAS_EXTENSO).join('|') + ')';",
    "    const VAL = '(?:r\\$)?\\s*[\\d.,]+';",
    "    const ehParcela =",
    "         new RegExp('\\b' + QTD + '\\s*x\\s*(?:de|a)\\s*' + VAL).test(t)",
    "      || new RegExp('\\b(?:em|de)\\s+' + QTD + '\\s*(?:vezes|parcelas|meses)\\s+(?:de|a)\\s+' + VAL).test(t)",
    "      || new RegExp('\\b(?:parcelas?|presta[cç][oõ]es?)\\s+de\\s+' + VAL).test(t);",
]);
if (!s.includes(de)) { console.error('bloco ehParcela nao encontrado'); process.exit(1); }
s = s.replace(de, para);
fs.writeFileSync(f, s);
console.log('ok');
