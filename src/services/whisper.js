const axios    = require('axios');
const fs       = require('fs');
const FormData = require('form-data');

async function transcreverAudio(audioUrl, phone) {
  let fileName = null;
  try {
    // Baixa o áudio
    const resp = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    fileName = `./tmp_${phone}_${Date.now()}.ogg`;
    fs.writeFileSync(fileName, Buffer.from(resp.data));

    // Envia para o Whisper (OpenAI)
    const form = new FormData();
    form.append('file', fs.createReadStream(fileName));
    form.append('model', 'whisper-1');
    form.append('language', 'pt'); // força português → mais preciso

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