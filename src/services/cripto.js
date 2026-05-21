/**
 * Criptografia AES-256-GCM para credenciais de integrações.
 * Chave lida de NEGOCIOS_ENC_KEY (hex de 64 chars = 32 bytes).
 *
 * Se a chave não estiver configurada, salva em texto plano com aviso
 * — mantém o sistema funcionando em dev, mas bloqueia em produção.
 */
const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function getKey() {
  const hex = process.env.NEGOCIOS_ENC_KEY;
  if (!hex || hex.length < 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NEGOCIOS_ENC_KEY não configurada. Configure 64 chars hex antes de usar integrações em produção.');
    }
    // Dev: avisa mas não bloqueia
    console.warn('[cripto] NEGOCIOS_ENC_KEY ausente — credenciais salvas em TEXTO PLANO. Configure para produção.');
    return null;
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Criptografa um objeto (credentials) → string opaca.
 * Formato: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
function encrypt(obj) {
  const key = getKey();
  const plain = JSON.stringify(obj);
  if (!key) return plain; // dev fallback

  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct  = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Descriptografa string → objeto original.
 * Aceita tanto string criptografada quanto JSON puro (retrocompatível com dev).
 */
function decrypt(str) {
  if (!str) return {};
  if (typeof str === 'object') return str; // já deserializado pelo jsonb

  // JSON puro (dev sem chave configurada)
  if (!str.startsWith(PREFIX)) {
    try { return JSON.parse(str); } catch { return {}; }
  }

  const key = getKey();
  if (!key) {
    console.warn('[cripto] Tentativa de descriptografar sem chave configurada.');
    return {};
  }

  const parts = str.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return {};
  const [ivHex, tagHex, ctHex] = parts;

  const iv         = Buffer.from(ivHex, 'hex');
  const tag        = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');

  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { encrypt, decrypt };
