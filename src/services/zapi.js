const axios = require('axios');

const BASE = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}`;
const HEADERS = {
  'Content-Type': 'application/json',
  'client-token': process.env.ZAPI_CLIENT_TOKEN
};

// Envia mensagem de texto simples
async function enviarTexto(phone, message) {
  try {
    await axios.post(`${BASE}/send-text`, { phone, message }, { headers: HEADERS });
  } catch (e) {
    console.error(`❌ Erro ao enviar mensagem para ${phone}:`, e.message);
  }
}

// Envia mensagem com menu de opções rápidas
async function enviarMenu(phone, message) {
  try {
    await axios.post(`${BASE}/send-option-list`, {
      phone,
      message,
      optionList: {
        title: 'Ações rápidas',
        buttonLabel: 'Abrir menu',
        options: [
          { id: 'resumo', title: '📊 Ver resumo',    description: 'Saldo e gastos do mês' },
          { id: 'painel', title: '🌐 Abrir painel',  description: 'Gráficos completos' },
          { id: 'apagar', title: '❌ Excluir última', description: 'Desfazer último lançamento' }
        ]
      }
    }, { headers: HEADERS });
  } catch (e) {
    // Se o menu falhar, envia texto simples como fallback
    await enviarTexto(phone, message + '\n\nDigite: resumo | painel | excluir');
  }
}

// Envia uma imagem (URL pública OU data URI base64) com legenda opcional.
async function enviarImagem(phone, image, caption = '') {
  try {
    await axios.post(`${BASE}/send-image`, { phone, image, caption }, { headers: HEADERS });
  } catch (e) {
    console.error(`❌ Erro ao enviar imagem para ${phone}:`, e.message);
    // Fallback: ao menos manda o texto pra não perder o conteúdo.
    if (caption) await enviarTexto(phone, caption + '\n\n(⚠️ a imagem anexada falhou ao enviar)');
  }
}

// Mensagem com link enriquecido: capa (image, opcional) no topo + título +
// descrição (vira o "botão"/CTA) + corpo, com o card clicável abrindo linkUrl.
// Cai pra texto simples se o send-link falhar.
async function enviarLink(phone, { message, image, linkUrl, title, linkDescription }) {
  try {
    const body = { phone, message, linkUrl, title, linkDescription };
    if (image) body.image = image;
    await axios.post(`${BASE}/send-link`, body, { headers: HEADERS });
  } catch (e) {
    console.error(`❌ send-link falhou para ${phone} (fallback texto):`, e.message);
    await enviarTexto(phone, `${message}\n\n👉 ${linkUrl}`);
  }
}

// Mensagem interativa: header de IMAGEM (capa, paisagem no topo) + corpo +
// BOTÃO de URL (ex.: "Ver no painel"). É o formato do exemplo (Pierre).
// Cai pra send-link e, por fim, texto, se a conta não suportar botões.
async function enviarBotaoLink(phone, { message, image, title, footer, label, url }) {
  try {
    const body = {
      phone,
      message,
      buttonActions: [{ id: '1', type: 'URL', url, label: (label || 'Abrir').slice(0, 24) }],
    };
    if (title)  body.title = title;
    if (footer) body.footer = footer;
    if (image)  body.image = image;
    await axios.post(`${BASE}/send-button-actions`, body, { headers: HEADERS });
  } catch (e) {
    console.error(`❌ send-button-actions falhou para ${phone} (fallback link):`, e.response?.status || e.message);
    await enviarLink(phone, { message, image, linkUrl: url, title: title || '', linkDescription: label || 'Abrir' });
  }
}

module.exports = { enviarTexto, enviarMenu, enviarImagem, enviarLink, enviarBotaoLink };