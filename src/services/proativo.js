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

module.exports = { enviarProativo, provedor };
