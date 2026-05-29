const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CATEGORIAS = [
  'Mercado','Transporte','Lazer e Entretenimento','Saúde','Aluguel',
  'Educação','Casa','Salário','Alimentação','Recebimento','Transferências',
  'Internet','Pet','Padaria','Assinaturas','Vestuário','Impostos',
  'Viagem','Doações','Outros'
];

const PROMPT = `Você é a Sora, assistente financeira. Analise esta imagem — pode ser uma
nota fiscal, cupom fiscal, comprovante de pagamento/PIX, ou recibo.

Extraia os dados e retorne APENAS um JSON válido, sem texto antes ou depois:

{"acao":"salvar","tipo":"Gasto","valor":50.90,"categoria":"Mercado","observacao":"Nome do estabelecimento"}

Regras:
- "valor": o valor TOTAL pago (número, ponto decimal). Procure por "TOTAL", "VALOR PAGO", "VALOR A PAGAR".
- "tipo": "Gasto" para compras/pagamentos; "Recebimento" só se for claramente um comprovante de dinheiro RECEBIDO.
- "categoria": escolha a mais adequada entre: ${CATEGORIAS.join(', ')}.
- "observacao": nome do estabelecimento/loja (ex: "Supermercado Pão de Açúcar"). Se não identificar, use o tipo de comércio.
- Se a imagem NÃO for um documento financeiro legível (foto aleatória, sem valor identificável), retorne: {"acao":"erro_ocr"}`;

// Lê uma nota fiscal / comprovante a partir da URL da imagem (visão do GPT-4o-mini)
async function lerNotaFiscal(imageUrl) {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    });
    const texto = (response.choices[0].message.content || '').trim();
    const limpo = texto.replace(/```json|```/g, '').trim();
    return JSON.parse(limpo);
  } catch (err) {
    console.error('❌ Erro no OCR de nota fiscal:', err.message);
    return { acao: 'erro_ocr' };
  }
}

module.exports = { lerNotaFiscal };
