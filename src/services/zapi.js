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

module.exports = { enviarTexto, enviarMenu };