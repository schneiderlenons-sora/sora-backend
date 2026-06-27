const axios    = require('axios');
const fs       = require('fs');
const FormData = require('form-data');

// Vocabulário base que enviesa a transcrição (nomes inventados como "Nubank"
// e marcas que o Whisper erra sem contexto). O `prompt` do Whisper não vira
// texto — só guia a grafia. As contas do usuário entram via `vocab`.
const VOCAB_BASE =
  'Transcrição de finanças no Brasil. Bancos e apps: Nubank, Inter, Itaú, ' +
  'Bradesco, Santander, Caixa, C6 Bank, PicPay, Mercado Pago, Banco do Brasil, ' +
  'Will Bank, Neon, BTG. Marcas: Shopee, Shein, iFood, Uber, 99, Amazon, ' +
  'Mercado Livre, AliExpress, Netflix, Spotify, Magalu. ' +
  'Termos: gastei, paguei, recebi, crédito, débito, reais, parcelado.';

async function transcreverAudio(audioSrc, phone, vocab = '') {
  let fileName = null;
  try {
    // audioSrc pode ser URL (Z-API, pública) OU Buffer (Cloud API/Meta — a
    // mídia já vem baixada com o token, pois a URL da Meta exige Authorization).
    const buf = Buffer.isBuffer(audioSrc)
      ? audioSrc
      : Buffer.from((await axios.get(audioSrc, { responseType: 'arraybuffer' })).data);
    fileName = `./tmp_${phone}_${Date.now()}.ogg`;
    fs.writeFileSync(fileName, buf);

    // Envia para o Whisper (OpenAI)
    const form = new FormData();
    form.append('file', fs.createReadStream(fileName));
    form.append('model', 'whisper-1');
    form.append('language', 'pt'); // força português → mais preciso
    // Dica de vocabulário: base + contas do usuário ("Nubank Crédito" etc.)
    const prompt = vocab ? `${VOCAB_BASE} Minhas contas: ${vocab}.` : VOCAB_BASE;
    form.append('prompt', prompt);

    const transcricao = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    return transcricao.data.text;
  } catch (err) {
    console.error('❌ Erro Whisper:', err.message);
    throw new Error('Não consegui entender o áudio. Pode repetir?');
  } finally {
    // Apaga o arquivo temporário sempre, mesmo se der erro
    if (fileName && fs.existsSync(fileName)) fs.unlinkSync(fileName);
  }
}

module.exports = { transcreverAudio };