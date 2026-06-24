// =====================================================================
// Auto-categorização por descrição (Open Finance / Pluggy / OFX / WhatsApp).
// ESPELHA o lib/categorizar.ts do FRONTEND — manter os dois em sincronia.
// Retorna o NOME SIMPLES da categoria (sem emoji); o painel casa por nome
// normalizado, então "Mercado" agrupa em "🛒 Mercado", etc.
//
// Ordem das regras IMPORTA: marca/específico antes de genérico. Keywords
// curtas (<4 letras) casam só como palavra inteira (evita falso positivo).
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
  // ── Marketplaces / Encomendas (subcategorias) ──
  { cat: 'Mercado Livre',  kws: ['mercado livre', 'mercadolivre', 'mercadolibre', 'meli '] },
  { cat: 'Amazon',         kws: ['amazon', 'amzn'] },
  { cat: 'Shopee',         kws: ['shopee'] },
  { cat: 'Aliexpress',     kws: ['aliexpress', 'ali express'] },
  { cat: 'TikTok Shop',    kws: ['tiktok', 'tik tok'] },
  { cat: 'Shein',          kws: ['shein'] },
  { cat: 'Encomendas',     kws: ['magazine luiza', 'magalu', 'americanas', 'casas bahia', 'submarino', 'kabum', 'pichau', 'terabyte', 'temu', 'wish', 'enjoei', 'pontofrio', 'ponto frio', 'extra com', 'fastshop', 'fast shop'] },

  // ── Transferências / Pix (não-consumo) ──
  { cat: 'Transferências', kws: ['mercado pago', 'mercadopago', 'pix enviado', 'pix recebido', 'pix ', 'ted ', 'doc ', 'transferencia', 'transferencias', 'transf '] },

  // ── Delivery / Alimentação ──
  { cat: 'iFood',          kws: ['ifood', 'i food'] },
  { cat: 'Alimentação',    kws: ['rappi', 'uber eats', 'ubereats', 'aiqfome', 'aiq fome', 'james delivery', 'ze delivery', 'zedelivery', 'delivery',
      'restaurante', 'restaur', 'lanchonete', 'lanches', 'hamburgueria', 'burger king', 'burguer', 'mcdonald', 'mc donalds', 'bobs', 'subway',
      'pizzaria', 'pizza', 'outback', 'habibs', 'spoleto', 'dominos', 'china in box', 'sushi', 'temaki', 'churrascaria', 'espetinho',
      'cafeteria', 'starbucks', 'kopenhagen', 'cacau show', 'sorveteria', 'acai', 'doceria', 'confeitaria', 'marmita', 'self service',
      'rotisseria', 'boteco', 'comida', 'restaurante e lanchonete'] },
  { cat: 'Padaria',        kws: ['padaria', 'panificadora', 'panific'] },

  // ── Transporte ──
  { cat: 'Uber',           kws: ['uber'] },
  { cat: 'Transporte',     kws: ['99app', '99 pop', '99pop', '99 tecnologia', 'cabify', 'indrive', 'in drive', 'blablacar',
      'posto', 'ipiranga', 'shell ', 'petrobras', 'br mania', 'gasolina', 'combustivel', 'etanol', 'diesel',
      'estacionamento', 'estapar', 'zona azul', 'pedagio', 'sem parar', 'conectcar', 'veloe', 'move mais', 'ccr ',
      'metro', 'metrô', 'cptm', 'bilhete unico', 'sptrans', 'onibus', 'passagem rodoviaria', 'buser', 'autopecas', 'auto pecas',
      'oficina mecanica', 'borracharia', 'licenciamento'] },

  // ── Vestuário / Esporte (subcategorias) ──
  { cat: 'Nike',           kws: ['nike'] },
  { cat: 'Adidas',         kws: ['adidas'] },
  { cat: 'Vestuário',      kws: ['renner', 'riachuelo', 'pernambucanas', 'marisa', 'c&a ', 'c e a ', 'zara', 'hering', 'puma', 'reserva ',
      'centauro', 'netshoes', 'dafiti', 'calcados', 'sapataria', 'arezzo', 'melissa', 'youcom', 'leader', 'calvin klein', 'tommy',
      'olympikus', 'mizuno', 'decathlon', 'track field', 'osklen', 'colcci', 'lojas avenida', 'besni'] },

  // ── Beleza / Estética ──
  { cat: 'Beleza',         kws: ['salao', 'barbearia', 'barber', 'cabeleireiro', 'cabelereiro', 'manicure', 'estetica',
      'depilacao', 'sobrancelha', 'boticario', 'natura', 'sephora', 'perfumaria', 'quem disse berenice', 'avon'] },

  // ── Academia / Fitness ──
  { cat: 'Academia',       kws: ['academia', 'smartfit', 'smart fit', 'bodytech', 'bioritmo', 'bio ritmo', 'selfit', 'bluefit',
      'crossfit', 'personal trainer', 'pilates', 'tecnofit', 'totalpass', 'gympass', 'wellhub'] },

  // ── Assinaturas / Streaming (subcategorias) ──
  { cat: 'Netflix',        kws: ['netflix'] },
  { cat: 'Spotify',        kws: ['spotify'] },
  { cat: 'Disney+',        kws: ['disney'] },
  { cat: 'Prime Video',    kws: ['prime video', 'primevideo', 'amazon prime'] },
  { cat: 'HBO Max',        kws: ['hbomax', 'hbo max', 'hbo'] },
  { cat: 'Globo Play',     kws: ['globoplay', 'globo play'] },
  { cat: 'Assinaturas',    kws: ['youtube premium', 'youtube music', 'deezer', 'tidal', 'apple music', 'apple com bill', 'apple.com bill',
      'canva', 'notion', 'chatgpt', 'openai', 'midjourney', 'adobe', 'office 365', 'microsoft 365', 'google one', 'icloud',
      'paramount', 'crunchyroll', 'star plus', 'starplus', 'mubi', 'telecine', 'dropbox', 'linkedin premium', 'assinatura'] },

  // ── Mercado / supermercado ──
  { cat: 'Mercado',        kws: ['mercado', 'supermercado', 'super mercado', 'atacad', 'atacarejo', 'carrefour', 'assai', 'assaí',
      'pao de acucar', 'extra hiper', 'bompreco', 'hortifruti', 'sams club', 'sam s club', 'makro', 'tenda atac',
      'dia supermercado', 'sonda', 'st marche', 'mambo', 'natural da terra', 'sacolao', 'quitanda', 'hipermercado',
      'mercearia', 'prezunic', 'guanabara', 'zona sul', 'verdemar', 'cometa supermercados'] },

  // ── Saúde / Farmácia ──
  { cat: 'Saúde',          kws: ['farmacia', 'drogaria', 'drogasil', 'droga raia', 'pacheco', 'pague menos', 'panvel', 'raia ',
      'extrafarma', 'venancio', 'nissei', 'ultrafarma', 'clinica', 'hospital', 'laboratorio', 'fleury', 'sabin', 'hermes pardini',
      'unimed', 'amil', 'hapvida', 'notredame', 'odonto', 'dentista', 'ortodontia', 'consulta medica', 'exame', 'fisioterapia',
      'psicolog', 'terapia', 'vacina', 'otica', 'oculos'] },

  // ── Pet ──
  { cat: 'Pet',            kws: ['petz', 'cobasi', 'petlove', 'veterinari', 'pet shop', 'petshop', 'pet center', 'clinipet', 'agropet', 'racao'] },

  // ── Educação ──
  { cat: 'Educação',       kws: ['udemy', 'coursera', 'alura', 'duolingo', 'rocketseat', 'hotmart', 'escola', 'colegio',
      'faculdade', 'universidade', 'uninter', 'estacio', 'anhanguera', 'qconcursos', 'gran cursos', 'mensalidade escolar',
      'livraria', 'saraiva', 'papelaria', 'kumon', 'wizard', 'ccaa', 'fisk', 'cna ', 'curso de'] },

  // ── Lazer / Entretenimento ──
  { cat: 'Lazer e Entretenimento', kws: ['cinema', 'cinemark', 'kinoplex', 'ingresso', 'sympla', 'eventim', 'show ', 'teatro',
      'parque', 'hopi hari', 'beto carrero', 'steam', 'playstation', 'xbox', 'nintendo', 'riot games', 'epic games', 'twitch',
      'boliche', 'balada'] },

  // ── Viagem / Hospedagem ──
  { cat: 'Viagem',         kws: ['latam', 'gol linhas', 'azul linhas', 'azul viagens', 'smiles', 'decolar', '123 milhas',
      'cvc ', 'maxmilhas', 'expedia', 'hoteis com', 'airbnb', 'booking', 'hotel', 'pousada', 'hostel', 'resort',
      'rentcars', 'localiza', 'movida', 'unidas', 'rent a car'] },

  // ── Internet / Telefone / TV ──
  { cat: 'Internet',       kws: ['vivo fibra', 'vivo ', 'claro net', 'claro ', 'oi fibra', 'tim sa', 'tim celular', 'net servicos',
      'sky ', 'telefonica', 'internet', 'banda larga', 'fibra otica', 'recarga celular', 'tv por assinatura'] },

  // ── Contas de casa (energia, água, gás, condomínio) ──
  { cat: 'Contas',         kws: ['enel', 'cpfl', 'light ', 'cemig', 'copel', 'celpe', 'coelba', 'energisa', 'equatorial energia',
      'elektro', 'energia eletrica', 'conta de luz', 'sabesp', 'cedae', 'copasa', 'sanepar', 'caesb', 'embasa', 'conta de agua',
      'comgas', 'gas natural', 'ultragaz', 'liquigas', 'condominio', 'taxa condominio'] },

  // ── Moradia ──
  { cat: 'Moradia',        kws: ['aluguel', 'imobiliaria', 'quintoandar', 'quinto andar', 'construtora', 'leroy merlin',
      'telhanorte', 'tok stok', 'madeira madeira', 'mobly', 'casa bahia moveis'] },

  // ── Impostos / Taxas ──
  { cat: 'Impostos',       kws: ['darf', 'ipva', 'iptu', 'imposto', 'receita federal', 'detran', 'multa de transito', 'tarifa bancaria'] },

  // ── Seguros ──
  { cat: 'Seguros',        kws: ['seguro', 'porto seguro', 'azul seguros', 'sulamerica seguro', 'bradesco seguros', 'allianz', 'mapfre', 'tokio marine'] },

  // ── Salário / Renda ──
  { cat: 'Salário',        kws: ['salario', 'folha de pagamento', 'folha pagamento', 'pro labore', 'pro-labore', 'provento', 'remuneracao', 'decimo terceiro'] },

  // ── Investimentos ──
  { cat: 'Investimentos',  kws: ['aplicacao', 'resgate', 'tesouro direto', 'corretora', 'xp investimentos', 'nuinvest', 'aporte', 'renda fixa', 'fundo de investimento', 'b3 '] },
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
  { cat: 'Mercado',                kws: ['supermarket', 'groceries', 'grocery', 'mercado', 'supermercado'] },
  { cat: 'Alimentação',            kws: ['food and drinks', 'food & drinks', 'restaurant', 'food delivery', 'fast food', 'bars', 'coffee', 'dining', 'aliment', 'restaurante', 'comida', 'bares', 'cafe'] },
  { cat: 'Transporte',             kws: ['transport', 'gas station', 'fuel', 'public transportation', 'parking', 'tolls', 'transporte', 'combustivel', 'pedagio', 'estacionamento'] },
  { cat: 'Uber',                   kws: ['ride hailing', 'ride-hailing', 'taxi', 'uber'] },
  { cat: 'Saúde',                  kws: ['health', 'pharmacy', 'drugstore', 'doctor', 'medical', 'saude', 'farmacia', 'medico'] },
  { cat: 'Beleza',                 kws: ['beauty', 'personal care', 'cosmetic', 'beleza', 'estetica'] },
  { cat: 'Academia',               kws: ['gym', 'fitness', 'academia'] },
  { cat: 'Vestuário',              kws: ['clothing', 'apparel', 'fashion', 'shoes', 'vestuario', 'roupa', 'calcado'] },
  { cat: 'Assinaturas',            kws: ['streaming', 'subscription', 'digital services', 'software', 'assinatura'] },
  { cat: 'Lazer e Entretenimento', kws: ['leisure', 'entertainment', 'gaming', 'games', 'lazer', 'entreten', 'jogos'] },
  { cat: 'Viagem',                 kws: ['travel', 'airline', 'airlines', 'hotel', 'lodging', 'accommodation', 'viagem', 'hospedagem', 'passagens'] },
  { cat: 'Educação',               kws: ['education', 'school', 'tuition', 'courses', 'educacao', 'escola', 'curso'] },
  { cat: 'Pet',                    kws: ['pet', 'pets', 'veterinary'] },
  { cat: 'Internet',               kws: ['telecommunication', 'phone', 'mobile', 'internet', 'telefon', 'celular'] },
  { cat: 'Contas',                 kws: ['utilities', 'electricity', 'water', 'gas', 'bills', 'energia', 'agua', 'luz', 'contas', 'condominio'] },
  { cat: 'Moradia',                kws: ['rent', 'housing', 'home improvement', 'aluguel', 'moradia', 'casa'] },
  { cat: 'Impostos',               kws: ['tax', 'taxes', 'government', 'imposto', 'tributo'] },
  { cat: 'Seguros',                kws: ['insurance', 'seguro'] },
  { cat: 'Investimentos',          kws: ['investment', 'investments', 'investimento', 'aplicacao'] },
  { cat: 'Transferências',         kws: ['transfer', 'transfers', 'pix', 'ted', 'doc', 'transferencia', 'wire'] },
  { cat: 'Salário',                kws: ['salary', 'income', 'payroll', 'wages', 'salario', 'renda', 'provento'] },
  { cat: 'Encomendas',             kws: ['shopping', 'online shopping', 'e-commerce', 'ecommerce', 'marketplace', 'compras', 'electronics', 'eletronicos'] },
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
