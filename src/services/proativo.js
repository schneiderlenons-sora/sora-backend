// ── Envio PROATIVO (welcome, briefing, resumos, recuperação) ─────────────────
// Mensagens iniciadas pela Sora, normalmente FORA da janela de 24h.
//
//  - Z-API  → não tem janela; manda o `texto` livre (rico) como sempre.
//  - Meta   → fora da janela só TEMPLATE aprovado passa → manda o template.
//             (cai pro texto livre se nenhum template foi informado.)
//
// Uso:
//   enviarProativo(phone, {
//     texto: 'mensagem rica completa (Z-API)',
//     template: { name: 'resumo_semanal', params: [nome, valor], lang: 'pt_BR',
//                 opts: { urlButtonParam: 'dashboard' } },
//   });
//
// Catálogo dos templates a criar na Meta: docs/MIGRACAO-WHATSAPP-TEMPLATES.md
const enviar = require('./mensageiro');

function provedor() {
  return (process.env.WHATSAPP_PROVIDER || 'zapi').toLowerCase();
}

async function enviarProativo(phone, { texto, template } = {}) {
  if (provedor() === 'meta' && template && template.name) {
    const wa = require('./whatsapp');
    return wa.enviarTemplate(phone, template.name, template.params || [], template.lang || 'pt_BR', template.opts || {});
  }
  // Z-API, ou Meta sem template definido (ou já dentro da janela de 24h).
  if (texto) return enviar.enviarTexto(phone, texto);
}

/**
 * Mesma coisa, mas dizendo POR QUE falhou — pra quem tem cadeia de modelos de
 * reserva e precisa decidir se vale tentar o próximo.
 *
 * ⚠️ NÃO É DETALHE DE LOG: tentar outro modelo depois de uma falha AMBÍGUA
 * (timeout, 5xx, rate limit) manda a MESMA mensagem duas vezes, porque a Meta
 * pode ter aceitado e só a resposta ter se perdido. Só a família 132xxx prova
 * que nada saiu — ver `ehFalhaDeModelo` em services/whatsapp.js.
 *
 * @returns {{ok: boolean, falhaDeModelo: boolean, code?: number|null}}
 */
async function enviarProativoDetalhado(phone, { texto, template } = {}) {
  if (provedor() === 'meta' && template && template.name) {
    const wa = require('./whatsapp');
    return wa.enviarTemplateDetalhado(phone, template.name, template.params || [], template.lang || 'pt_BR', template.opts || {});
  }
  // Fora do trilho Meta o envio é texto livre, que não devolve confirmação —
  // então NUNCA declaramos falha de modelo, senão quem chama tentaria de novo
  // e a pessoa receberia a mensagem repetida.
  if (texto) { await enviar.enviarTexto(phone, texto); return { ok: true, falhaDeModelo: false }; }
  return { ok: false, falhaDeModelo: false };
}

module.exports = { enviarProativo, enviarProativoDetalhado, provedor };
