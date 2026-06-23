// =====================================================================
// Auto-categorização por descrição (Open Finance / Pluggy / extratos).
// ESPELHA o lib/categorizar.ts do FRONTEND (usado no import OFX) — manter os
// dois em sincronia. Retorna o NOME SIMPLES da categoria (sem emoji); o painel
// casa por nome normalizado, então "Mercado" agrupa em "🛒 Mercado", etc.
//
// Ordem das regras IMPORTA: específico antes de genérico.
// =====================================================================

function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// substring p/ palavras longas (>=4); palavra inteira p/ curtas.
function casa(texto, kw) {
  if (kw.length >= 4) return texto.includes(kw);
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|$)`).test(texto);
}

const REGRAS = [
  { cat: 'Mercado Livre', kws: ['mercado livre', 'mercadolivre', 'mercadolibre', 'meli'] },
  { cat: 'Amazon',        kws: ['amazon', 'amzn'] },
  { cat: 'Shopee',        kws: ['shopee'] },
  { cat: 'Aliexpress',    kws: ['aliexpress', 'alibaba', 'ali express'] },
  { cat: 'TikTok Shop',   kws: ['tiktok', 'tik tok'] },
  { cat: 'Shein',         kws: ['shein'] },

  { cat: 'Transferências', kws: ['mercado pago', 'mercadopago', 'pix ', 'ted ', 'doc ', 'transferencia'] },

  { cat: 'iFood',       kws: ['ifood', 'i food'] },
  { cat: 'Alimentação', kws: ['rappi', 'restaurante', 'lanchonete', 'burger', 'mcdonald', 'mc donalds', 'bobs', 'subway', 'pizzaria', 'pizza', 'outback', 'habibs', 'spoleto', 'dominos', 'china in box', 'sushi', 'cafeteria', 'starbucks'] },
  { cat: 'Padaria',     kws: ['padaria', 'panificadora'] },

  { cat: 'Uber',        kws: ['uber'] },
  { cat: 'Transporte',  kws: ['99app', '99 pop', '99pop', 'cabify', 'posto', 'ipiranga', 'shell', 'petrobras', 'gasolina', 'combustivel', 'estacionamento', 'pedagio', 'sem parar', 'conectcar', 'veloe', 'metro', 'onibus', 'blablacar'] },

  { cat: 'Nike',        kws: ['nike'] },
  { cat: 'Adidas',      kws: ['adidas'] },
  { cat: 'Vestuário',   kws: ['renner', 'riachuelo', 'cea', 'c&a', 'zara', 'hering', 'puma', 'reserva', 'marisa', 'pernambucanas'] },

  { cat: 'Netflix',     kws: ['netflix'] },
  { cat: 'Spotify',     kws: ['spotify'] },
  { cat: 'Disney+',     kws: ['disney'] },
  { cat: 'Prime Video', kws: ['prime video', 'primevideo'] },
  { cat: 'HBO Max',     kws: ['hbo', 'hbomax'] },
  { cat: 'Globo Play',  kws: ['globoplay', 'globo play'] },
  { cat: 'Assinaturas', kws: ['youtube premium', 'deezer', 'canva', 'notion', 'apple com', 'apple.com', 'google ', 'paramount', 'crunchyroll'] },

  { cat: 'Mercado',     kws: ['mercado', 'supermercado', 'atacad', 'carrefour', 'assai', 'pao de acucar', 'big bompreco', 'hortifruti', 'sams club', 'makro', 'tenda atac'] },

  { cat: 'Saúde',       kws: ['farmacia', 'drogaria', 'drogasil', 'pague menos', 'panvel', 'raia', 'clinica', 'hospital', 'laboratorio', 'unimed', 'odonto', 'dentista', 'ultrafarma'] },

  { cat: 'Pet',         kws: ['petz', 'cobasi', 'petlove', 'veterinari', 'pet shop', 'petshop'] },

  { cat: 'Educação',    kws: ['udemy', 'coursera', 'alura', 'duolingo', 'faculdade', 'universidade', 'qconcursos'] },

  { cat: 'Lazer e Entretenimento', kws: ['cinema', 'cinemark', 'ingresso', 'steam', 'playstation', 'xbox', 'nintendo'] },

  { cat: 'Viagem',      kws: ['latam', 'airbnb', 'booking', ' hotel', 'decolar', '123 milhas', 'cvc viagens', 'azul linhas', 'gol linhas'] },

  { cat: 'Internet',    kws: ['vivo fibra', 'claro net', 'net servicos', 'telefonica', 'oi fibra'] },
];

// Nome da categoria sugerida pela descrição, ou null.
function categorizarDescricao(descricao) {
  const t = normalizar(descricao);
  if (!t) return null;
  for (const regra of REGRAS) {
    for (const kw of regra.kws) {
      const k = normalizar(kw);
      if (k && casa(t, k)) return regra.cat;
    }
  }
  return null;
}

// Fallback: taxonomia do próprio Pluggy (tx.category, em inglês/PT) → Sora.
// Avaliado por substring no nome normalizado da categoria do Pluggy.
const MAPA_PLUGGY = [
  { cat: 'Mercado',                kws: ['supermarket', 'groceries', 'mercado'] },
  { cat: 'Alimentação',            kws: ['food and drinks', 'restaurant', 'food delivery', 'fast food', 'bars', 'coffee', 'aliment', 'restaurante'] },
  { cat: 'Transporte',             kws: ['transport', 'gas station', 'public transportation', 'parking', 'tolls', 'transporte'] },
  { cat: 'Uber',                   kws: ['ride hailing', 'taxi', 'uber'] },
  { cat: 'Saúde',                  kws: ['health', 'pharmacy', 'doctor', 'medical', 'saude', 'farmacia'] },
  { cat: 'Vestuário',              kws: ['clothing', 'apparel', 'fashion', 'vestuario'] },
  { cat: 'Assinaturas',            kws: ['streaming', 'subscription', 'assinatura'] },
  { cat: 'Lazer e Entretenimento', kws: ['leisure', 'entertainment', 'gaming', 'lazer', 'entreten'] },
  { cat: 'Viagem',                 kws: ['travel', 'airline', 'hotel', 'lodging', 'viagem'] },
  { cat: 'Educação',               kws: ['education', 'school', 'tuition', 'educacao'] },
  { cat: 'Pet',                    kws: ['pet'] },
  { cat: 'Internet',               kws: ['telecommunication', 'phone', 'internet', 'utilities', 'bills'] },
  { cat: 'Transferências',         kws: ['transfer', 'pix', 'ted', 'doc', 'transferencia'] },
  { cat: 'Salário',                kws: ['salary', 'income', 'payroll', 'salario', 'renda'] },
  { cat: 'Encomendas',             kws: ['shopping', 'online', 'e-commerce', 'ecommerce', 'marketplace'] },
];

function mapearCategoriaPluggy(pluggyCat) {
  const t = normalizar(pluggyCat);
  if (!t) return null;
  for (const regra of MAPA_PLUGGY) {
    for (const kw of regra.kws) {
      if (casa(t, normalizar(kw))) return regra.cat;
    }
  }
  return null;
}

// Decisão final: descrição (mesma engine do OFX) → categoria do Pluggy → 'Outros'.
function categorizar({ descricao, pluggyCategoria } = {}) {
  return categorizarDescricao(descricao) || mapearCategoriaPluggy(pluggyCategoria) || 'Outros';
}

module.exports = { categorizar, categorizarDescricao, mapearCategoriaPluggy };
