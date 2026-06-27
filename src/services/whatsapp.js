// ── WhatsApp Cloud API (oficial, Meta) ──────────────────────────────────────
// Espelha a MESMA interface do services/zapi.js (enviarTexto, enviarMenu,
// enviarImagem, enviarLink, enviarBotaoLink) pra que a troca de provedor não
// exija mexer nos ~20 handlers. A seleção do provedor é feita por um dispatcher
// (services/mensageiro.js) via env WHATSAPP_PROVIDER=zapi|meta.
//
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
const axios = require('axios');

const GRAPH = 'https://graph.facebook.com';
// Lidos em tempo de chamada (não no boot) — token pode mudar sem reiniciar.
const VERSION  = () => process.env.WHATSAPP_API_VERSION || 'v21.0';
const TOKEN    = () => process.env.WHATSAPP_TOKEN;
const PHONE_ID = () => process.env.WHATSAPP_PHONE_NUMBER_ID;

const HEADERS = () => ({
  Authorization: `Bearer ${TOKEN()}`,
  'Content-Type': 'application/json',
});

const MSG_URL = () => `${GRAPH}/${VERSION()}/${PHONE_ID()}/messages`;

// Telefone no formato da Meta: só dígitos, com DDI. A Meta normaliza celular BR
// removendo o 9º dígito no wa_id (55+DDD+8). Ao ENVIAR, reinserimos o 9 (vira
// 55+DDD+9+8 = 13 díg) — necessário p/ a allowlist de teste e correto em prod.
function to(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (/^55\d{10}$/.test(n)) n = n.slice(0, 4) + '9' + n.slice(4);
  return n;
}

// Helper base de POST /messages com log de erro detalhado da Meta.
async function postMessage(body) {
  try {
    const { data } = await axios.post(MSG_URL(), { messaging_product: 'whatsapp', ...body }, { headers: HEADERS() });
    return data;
  } catch (e) {
    const err = e.response?.data?.error;
    console.error(`❌ [whatsapp] erro ${e.response?.status || ''}:`, err?.message || e.message, err?.error_data?.details || '');
    throw e;
  }
}

// ── Texto simples ───────────────────────────────────────────────────────────
async function enviarTexto(phone, message) {
  try {
    await postMessage({ to: to(phone), type: 'text', text: { preview_url: true, body: String(message || '').slice(0, 4096) } });
  } catch {/* já logado */}
}

// ── Menu (lista interativa) ─ equivalente ao send-option-list do Z-API ───────
async function enviarMenu(phone, message) {
  try {
    await postMessage({
      to: to(phone),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: String(message || '').slice(0, 1024) },
        action: {
          button: 'Abrir menu',
          sections: [{
            title: 'Ações rápidas',
            rows: [
              { id: 'resumo', title: '📊 Ver resumo',     description: 'Saldo e gastos do mês' },
              { id: 'painel', title: '🌐 Abrir painel',    description: 'Gráficos completos' },
              { id: 'apagar', title: '❌ Excluir última',  description: 'Desfazer último lançamento' },
            ],
          }],
        },
      },
    });
  } catch {
    // Fallback texto (igual ao zapi.js)
    await enviarTexto(phone, message + '\n\nDigite: resumo | painel | excluir');
  }
}

// Faz upload de uma imagem em data URI (base64) e retorna o media id.
async function uploadImagemDataUri(dataUri) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUri);
  if (!m) return null;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', Buffer.from(m[2], 'base64'), { filename: 'imagem.png', contentType: m[1] });
  const { data } = await axios.post(`${GRAPH}/${VERSION()}/${PHONE_ID()}/media`, form, {
    headers: { Authorization: `Bearer ${TOKEN()}`, ...form.getHeaders() },
  });
  return data?.id || null;
}

// ── Imagem (URL pública OU data URI base64) com legenda ──────────────────────
async function enviarImagem(phone, image, caption = '') {
  try {
    let imgObj;
    if (/^https?:\/\//.test(image)) {
      imgObj = { link: image };
    } else if (/^data:image\//.test(image)) {
      const id = await uploadImagemDataUri(image);
      if (!id) throw new Error('upload data URI falhou');
      imgObj = { id };
    } else {
      throw new Error('formato de imagem não suportado');
    }
    if (caption) imgObj.caption = String(caption).slice(0, 1024);
    await postMessage({ to: to(phone), type: 'image', image: imgObj });
  } catch (e) {
    console.error(`❌ [whatsapp] enviarImagem falhou para ${phone}:`, e.message);
    if (caption) await enviarTexto(phone, caption + '\n\n(⚠️ a imagem anexada falhou ao enviar)');
  }
}

// ── Link enriquecido / botão CTA de URL ──────────────────────────────────────
// Na Cloud API, link e botão viram a MESMA mensagem interativa (cta_url), que
// na sessão (janela 24h) suporta header de imagem + corpo + botão clicável.
async function enviarBotaoLink(phone, { message, image, title, footer, label, url }) {
  try {
    const interactive = {
      type: 'cta_url',
      body: { text: String(message || '').slice(0, 1024) },
      action: { name: 'cta_url', parameters: { display_text: (label || 'Abrir').slice(0, 20), url } },
    };
    if (title)  interactive.header = { type: 'text', text: String(title).slice(0, 60) };
    if (image)  interactive.header = { type: 'image', image: /^https?:\/\//.test(image) ? { link: image } : undefined };
    if (footer) interactive.footer = { text: String(footer).slice(0, 60) };
    // Header de imagem por data URI precisa de upload — degrada pra sem header.
    if (interactive.header?.type === 'image' && !interactive.header.image) delete interactive.header;
    await postMessage({ to: to(phone), type: 'interactive', interactive });
  } catch (e) {
    console.error(`❌ [whatsapp] cta_url falhou para ${phone} (fallback texto):`, e.message);
    await enviarTexto(phone, `${message}\n\n👉 ${url}`);
  }
}

// enviarLink: mesma semântica do Z-API → reusa o botão CTA, caindo pra texto.
async function enviarLink(phone, { message, image, linkUrl, title, linkDescription }) {
  await enviarBotaoLink(phone, { message, image, title, label: linkDescription || 'Abrir', url: linkUrl });
}

// ── Template (mensagem PROATIVA fora da janela de 24h) ───────────────────────
// Fora da janela só template aprovado passa. bodyParams preenchem {{1}}, {{2}}…
// do corpo; opts.urlButtonParam preenche o sufixo dinâmico de um botão de URL.
// Ver o catálogo do que criar na Meta em docs/MIGRACAO-WHATSAPP-TEMPLATES.md.
async function enviarTemplate(phone, name, bodyParams = [], lang = 'pt_BR', opts = {}) {
  try {
    const components = [];
    if (bodyParams.length) {
      components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) });
    }
    if (opts.urlButtonParam != null) {
      components.push({
        type: 'button', sub_type: 'url', index: opts.urlButtonIndex ?? 0,
        parameters: [{ type: 'text', text: String(opts.urlButtonParam) }],
      });
    }
    const template = { name, language: { code: lang } };
    if (components.length) template.components = components;
    await postMessage({ to: to(phone), type: 'template', template });
  } catch {/* já logado em postMessage */}
}

// ── Download de mídia recebida (áudio/imagem) ────────────────────────────────
// A Meta entrega um media id; resolvemos a URL e baixamos COM o token.
// Retorna { buffer, mime } (ou null). Whisper/OCR consumirão isso na fase 2.
async function baixarMidia(mediaId) {
  try {
    const meta = await axios.get(`${GRAPH}/${VERSION()}/${mediaId}`, { headers: { Authorization: `Bearer ${TOKEN()}` } });
    const url = meta.data?.url;
    if (!url) return null;
    const bin = await axios.get(url, { headers: { Authorization: `Bearer ${TOKEN()}` }, responseType: 'arraybuffer' });
    return { buffer: Buffer.from(bin.data), mime: meta.data?.mime_type || bin.headers['content-type'] || 'application/octet-stream' };
  } catch (e) {
    console.error('❌ [whatsapp] baixarMidia falhou:', e.response?.status || e.message);
    return null;
  }
}

module.exports = { enviarTexto, enviarMenu, enviarImagem, enviarLink, enviarBotaoLink, baixarMidia, enviarTemplate };
