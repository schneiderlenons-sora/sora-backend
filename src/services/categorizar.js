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
// Prefixo '=' força palavra inteira mesmo em kw longa — pra kw que é sufixo de
// outra palavra comum (ex.: '=racao', senão "libeRACAO"/"decoRACAO" viram Pet).
function casa(texto, kw) {
  const exato = kw[0] === '=';
  const k = exato ? kw.slice(1) : kw;
  if (!exato && k.length >= 4) return texto.includes(k);
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|$)`).test(texto);
}

// Taxonomia v3 (ver sql/084_categorias_v3.sql). Marca conhecida → subcategoria
// da marca (nesta certa + logo no painel). Senão, keyword → subcategoria óbvia
// ou categoria-pai. Ordem: MAIS específico → genérico.
const REGRAS = [
  // ── PREFIXO DE ADQUIRENTE — antes de TUDO ────────────────────────────────
  //
  // `IFD*` é o descritor que o iFood carimba na fatura ("IFD*NOME DA LOJA").
  // É um sinal ESTRUTURAL — quem cobrou foi o iFood, ponto — e por isso vale
  // mais que qualquer palavra achada no nome do restaurante.
  //
  // ⚠️ ESTÁ NO TOPO, e não no bloco de Delivery lá embaixo, por duas razões
  // medidas na base:
  //   1. Sem isto quem decidia era o nome da LOJA: "IFD*SAGUACU PIZZARIA"
  //      virava Restaurante, "IFD*KAKA LANCHES" virava Lanches e o resto caía
  //      em Outros. Medido: 73 lançamentos, R$ 4.431,65, espalhados por 11
  //      categorias — e a categoria iFood, que existe justamente pra dar esse
  //      total, ficava com 4.
  //   2. A regra de Transferências casa `'ted '` por SUBSTRING, então
  //      "IFD*UNITED FOODS" viraria Transferência antes de chegar no Delivery.
  //
  // ⚠️ Consequência ACEITA: pedido de FARMÁCIA pelo iFood ("IFD*RAIA
  // DROGASIL") passa a contar como iFood, não Farmácia. É o preço de o total
  // do iFood ser confiável — sem ele o limite de iFood não significa nada. O
  // nome da loja continua visível na descrição.
  //
  // Medido na base inteira: 75 descrições têm o token `ifd` e as 75 são iFood.
  // Falso positivo zero. Como 'ifd' tem 3 letras, `casa()` já exige palavra
  // inteira — "ifd" preso dentro de outra palavra não casa.
  { cat: 'iFood',          kws: ['ifd'] },

  // ── Encomendas / Compras (marcas) — antes de tudo ──
  // "amazon prime" é streaming, não marketplace → checa ANTES de 'amazon'.
  { cat: 'Prime Video',    kws: ['amazon prime', 'prime video', 'primevideo'] },
  { cat: 'Mercado Livre',  kws: ['mercado livre', 'mercadolivre', 'mercadolibre', 'meli '] },
  { cat: 'Amazon',         kws: ['amazon', 'amzn'] },
  { cat: 'Shopee',         kws: ['shopee'] },
  { cat: 'Aliexpress',     kws: ['aliexpress', 'ali express'] },
  { cat: 'TikTok Shop',    kws: ['tiktok shop', 'tiktok', 'tik tok'] },
  { cat: 'Shein',          kws: ['shein'] },
  { cat: 'Nike',           kws: ['nike'] },
  // 'payu adi': o PayU é gateway de MUITA loja, então 'payu' sozinho não diz
  // nada — mas o campo do adquirente corta em 22 caracteres e a Adidas chega
  // truncada ("PayU        *ADI"). Exigir as duas palavras JUNTAS é o que
  // separa a Adidas de qualquer outro lojista do PayU.
  { cat: 'Adidas',         kws: ['adidas', 'payu adi'] },
  { cat: 'Encomendas',     kws: ['magazine luiza', 'magalu', 'americanas', 'casas bahia', 'submarino', 'kabum', 'pichau', 'terabyte', 'temu', 'wish', 'enjoei', 'pontofrio', 'ponto frio', 'fastshop', 'fast shop', 'shopify'] },

  // ── Assinatura da Sora (EC*SORA no extrato) — antes do genérico ──
  { cat: 'Assinaturas',    kws: ['ec sora', 'forsora', 'sora ai'] },

  // ── Trabalho / Negócio (anúncios e ferramentas) ──
  { cat: 'Facebook Ads',   kws: ['facebk', 'facebook ad', 'fb ads', 'meta ads', 'meta plataform', 'instagram ad', 'anuncio facebook', 'anuncios facebook', 'anuncio instagram', 'anuncios instagram', 'facebook'] },
  { cat: 'Google Ads',     kws: ['google ads', 'googleads', 'google adwords'] },
  { cat: 'Empreendimento', kws: ['tiktok ads', 'kwai for business', 'linkedin ads', 'mailchimp', 'fornecedor', 'frete', 'transportadora', 'embalagem', 'correios sedex'] },

  // ── Transferências / Pix / estornos (não-consumo) ──
  // A taxonomia v3 tem subcategorias próprias (PIX, Boleto, Transferência
  // recebida) — antes tudo caía no genérico "Transferências" e o usuário perdia
  // a quebra. Específicas primeiro; "Transferências" fica só pro que sobra.
  { cat: 'PIX',            kws: ['pix enviado', 'pix recebido', 'pix qr', 'qr pix', 'pagamento pix', 'recebimento pix', 'pix ', '=pix'] },
  { cat: 'Transferência recebida', kws: ['deposito de dinheiro', 'deposito em conta', 'deposito recebido', 'deposito bancario',
      'dinheiro recebido', 'transferencia recebida', 'ted recebida', 'doc recebido', '=deposito'] },
  { cat: 'Boleto',         kws: ['boleto'] },
  { cat: 'Transferências', kws: ['mercado pago', 'mercadopago', 'ted ', 'doc ', 'transferencia', 'transferencias', 'transf ',
      'venda cancelada', 'liberacao de dinheiro', 'estorno', 'devolucao', 'reembolso', 'chargeback'] },

  // ── Delivery (marcas) — ANTES de comida genérica. "Zé Delivery" ≠ "delivery". ──
  { cat: 'iFood',          kws: ['ifood', 'i food'] },
  { cat: 'AiqFome',        kws: ['aiqfome', 'aiq fome'] },
  { cat: 'Zé Delivery',    kws: ['ze delivery', 'zedelivery', 'ze entrega'] },
  { cat: 'Rappi',          kws: ['rappi'] },
  { cat: 'Delivery',       kws: ['uber eats', 'ubereats', 'james delivery', 'delivery', 'tele entrega', 'daki', 'zé delivery'] },

  // ── Alimentação (subcategorias: Café, Padaria, Supermercado, Lanches, Restaurante) ──
  { cat: 'Café',           kws: ['cafeteria', 'starbucks', 'the coffee', 'kopenhagen', 'cacau show', 'cafe ', 'coffee'] },
  { cat: 'Padaria',        kws: ['padaria', 'panificadora', 'panific'] },
  { cat: 'Supermercado',   kws: ['mercado', 'supermercado', 'super mercado', 'atacad', 'atacarejo', 'carrefour', 'assai', 'assaí',
      'pao de acucar', 'extra hiper', 'bompreco', 'hortifruti', 'sams club', 'sam s club', 'makro', 'tenda atac',
      'dia supermercado', 'sonda', 'st marche', 'mambo', 'natural da terra', 'sacolao', 'quitanda', 'hipermercado',
      'mercearia', 'prezunic', 'guanabara', 'zona sul', 'verdemar', 'cometa supermercados',
      'creme de leite', 'creme de avela'] },   // ANTES do Autocuidado: "creme" lá é cosmético
  { cat: 'Lanches',        kws: ['lanchonete', 'lanches', 'lanche', 'hamburgueria', 'burger king', 'burguer', 'hamburgu', 'hamburguer',
      'mcdonald', 'mc donalds', 'bobs', 'subway', 'cheeseburger', 'x-tudo', 'x-salada', 'x-burguer', 'x-bacon', 'cachorro quente',
      'cachorro-quente', 'hot dog', 'hotdog', 'misto quente', 'sandui', 'sanduba', 'bauru', 'beirute', 'batata frita', 'porcao',
      'coxinha', 'coxinhas', 'pastel', 'pasteis', 'esfiha', 'esfirra', 'kibe', 'quibe', 'empada', 'empadao', 'enroladinho',
      'risole', 'rissole', 'bolinho', 'salgad', 'pao de queijo', 'pastelaria', 'tapioca', 'crepe', 'creperia', 'tapiocaria',
      'acaraje', 'food truck', 'foodtruck', 'food park', 'petiscaria', 'trailer de', 'quiosque', 'pipoca', 'churros'] },
  { cat: 'Restaurante',    kws: ['restaurante', 'restaur', 'pizzaria', 'pizza', 'outback', 'habibs', 'spoleto', 'dominos',
      'china in box', 'sushi', 'temaki', 'churrascaria', 'espetinho', 'sorveteria', 'acai', 'doceria', 'confeitaria', 'marmita',
      'self service', 'rotisseria', 'boteco', 'comida', 'galeto', 'frango assado', 'refeicao', 'refeicoes', 'prato feito',
      'prato do dia', 'marmit', 'marmitex', 'quentinha', 'buffet', 'bufe', 'por quilo', 'rodizio', 'yakisoba', 'lamen',
      'macarrao', 'lasanha', 'nhoque', 'feijoada', 'strogonoff', 'estrogonofe', 'parmegiana', 'churrasco'] },

  // ── Transporte (subcategorias: Combustível, apps, Estacionamento, Pedágio…) ──
  // "Me Leva" é app de corrida. O adquirente carimba "Me Leva Bq*Meleva" — as
  // duas grafias entram porque a fatura trunca de jeitos diferentes.
  // Medido: 9 lançamentos, 7 deles parados em Outros.
  { cat: 'Uber',           kws: ['uber', 'meleva', 'me leva'] },
  { cat: '99',             kws: ['99app', '99 pop', '99pop', '99 tecnologia', '99 taxi'] },
  { cat: 'Blablacar',      kws: ['blablacar', 'bla bla car'] },
  { cat: 'Combustível',    kws: ['posto', 'ipiranga', 'shell ', 'petrobras', 'br mania', 'gasolina', 'combustivel', 'etanol', 'diesel', 'alcool posto'] },
  { cat: 'Estacionamento', kws: ['estacionamento', 'estapar', 'zona azul', 'estar zona'] },
  { cat: 'Pedágio',        kws: ['pedagio', 'sem parar', 'conectcar', 'veloe', 'move mais', 'ccr ', 'ecovias', 'artesp'] },
  { cat: 'Manutenção do veículo', kws: ['oficina mecanica', 'borracharia', 'autopecas', 'auto pecas', 'auto center', 'funilaria', 'troca de oleo'] },
  // ⚠️ 'Ônibus' JÁ É subcategoria canônica de Transporte (🚌, sql/087) — só não
  // tinha regra, então toda passagem caía no pai genérico. As keywords saem de
  // 'Transporte' e vêm pra cá. Medido: 'onibus', 'buser' e 'passagem
  // rodoviaria' têm ZERO lançamentos na base — mover não recategoriza ninguém.
  //
  // ⚠️ 'bus servicos' é obrigatório JUNTO com 'clickbus': a fatura trunca em
  // "BUS SERVICOS*CLIC" e só o 'clickbus' deixaria esses de fora.
  // ⚠️ NUNCA 'bus' solto — casaria "busca"/"Buscapé". E NUNCA 'rodoviaria'
  // solto: casaria "Polícia Rodoviária Federal", que é multa, não passagem.
  { cat: 'Ônibus',         kws: ['clickbus', 'bus servicos', 'buser', 'onibus', 'passagem rodoviaria', 'brt'] },
  { cat: 'Transporte',     kws: ['cabify', 'indrive', 'in drive', 'metro', 'metrô', 'cptm', 'bilhete unico', 'sptrans',
      'licenciamento', 'taxi'] },

  // ── Compras (roupa/calçado/eletrônico) ──
  { cat: 'Calçados',       kws: ['centauro', 'netshoes', 'dafiti', 'calcados', 'sapataria', 'arezzo', 'melissa', 'olympikus', 'mizuno', 'usaflex'] },
  { cat: 'Eletrônicos',    kws: ['kabum', 'fast shop', 'samsung', 'apple store', 'iplace', 'girafa', 'eletronico'] },
  { cat: 'Roupas',         kws: ['renner', 'riachuelo', 'pernambucanas', 'marisa', 'c&a ', 'c e a ', 'zara', 'hering', 'puma', 'reserva ',
      'youcom', 'leader', 'calvin klein', 'tommy', 'decathlon', 'track field', 'osklen', 'colcci', 'lojas avenida', 'besni', 'roupa', 'vestuario'] },

  // ── Autocuidado ──
  // ⚠️ ANTES de Barbeiro e de Salão de beleza, de propósito: o descritor real é
  // "Vindi *Bodylaserbarba" (Vindi é o gateway; o nome da clínica vem depois do
  // '*'), e a Body Laser faz depilação a laser — 'depilacao' do Salão e o
  // "barba" no fim do nome roubariam a linha. Medido: 6 lançamentos, espalhados
  // por Consultas, Outros e Higiene Pessoal.
  { cat: 'Higiene Pessoal', kws: ['body laser', 'bodylaser'] },
  { cat: 'Barbeiro',       kws: ['barbearia', 'barbeiro', 'barber'] },
  { cat: 'Salão de beleza',kws: ['salao de beleza', 'salao', 'cabeleireiro', 'cabelereiro', 'sobrancelha', 'depilacao'] },
  { cat: 'Manicure',       kws: ['manicure', 'pedicure', 'nail', 'unhas'] },
  { cat: 'Autocuidado',    kws: ['dermatolog', 'esteticista', 'estetica', 'cirurgia plastica',
      'botox', 'harmoniza', 'preenchimento facial', 'corte de cabelo',
      'creme', 'perfume', 'pomada', 'hidratante', 'shampoo', 'xampu', 'condicionador', 'sabonete', 'desodorante',
      'protetor solar', 'maquiagem', 'batom', 'cosmetic', 'skincare', 'esmalte', 'barbeador', 'gilete',
      // ⚠️ '=natura' (palavra inteira), NUNCA 'natura' solto: como substring
      // ela casa dentro de "asSINATURA" e toda transação com "Assinatura X"
      // virava Autocuidado. Medido: "Assinatura Sora Premium" → Autocuidado.
      'escova de dente', 'creme dental', 'fio dental', 'enxaguante', 'boticario', '=natura', 'sephora', 'perfumaria', 'quem disse berenice', 'avon',
      'massagem', 'spa ', 'tatuagem', 'piercing'] },

  // ── Dieta / suplementos ──
  { cat: 'Dieta',          kws: ['whey', 'creatina', 'bcaa', 'suplemento', 'hipercalorico', 'pre treino', 'pre-treino',
      'maltodextrina', 'albumina', 'growth', 'max titanium', 'integralmedica', 'probiotica', 'vitamina', 'multivitaminico',
      'isotonico', 'gatorade', 'colageno', 'termogenico'] },

  // ── Alimentação genérica — o guarda-chuva do bloco de comida ─────────────
  //
  // O descritor da maquininha TRUNCA o nome: "Superfoods Alimentaca" (sem o
  // "o"), "RJPRODUTOSALIMENT", "MacamoAlimentos". Por isso a keyword é o
  // RADICAL 'aliment' — nenhum dos três casaria com a palavra "alimentação".
  //
  // ⚠️ FICA DEPOIS DE DIETA de propósito: "Suplemento Alimentar" é Dieta, e o
  //    radical o roubaria se viesse antes.
  // ⚠️ E DEPOIS de Padaria/Supermercado/Lanches/Restaurante, que são mais
  //    específicas — este é o último palpite do bloco, não o primeiro.
  // ⚠️ PIX e Transferências vencem o radical porque estão lá em cima. Sem essa
  //    ordem, "Transferência enviada|AMM X COMERCIO DE ALIMENTOS" viraria
  //    despesa de comida e sairia da conta de transferência. Medido na base.
  { cat: 'Alimentação',    kws: ['aliment'] },

  // ── Academia / Fitness ──
  { cat: 'Academia',       kws: ['academia', 'smartfit', 'smart fit', 'bodytech', 'bioritmo', 'bio ritmo', 'selfit', 'bluefit',
      'crossfit', 'personal trainer', 'pilates', 'tecnofit', 'totalpass', 'gympass', 'wellhub',
      // Franquias que faltavam. 'fitness' entra genérico de propósito: medido,
      // as 3 ocorrências da base ("Dellas Fitness") estavam em Outros, e a única
      // outra é uma transferência — que a regra de Transferências já vence.
      // ⚠️ NENHUMA academia chamada "Velocity" entra aqui: ela casaria o 'veloc'
      // do Cinema, lá embaixo. Ver o comentário de lá.
      'contorno do corpo', 'sportfit', 'sport fit', 'panobianco', 'justfit', 'just fit',
      'cia athletica', 'pratique fitness', 'skyfit', 'sky fit', 'ironberg', 'iron berg',
      'formula academia', 'bodyshape', 'body shape', 'fitness'] },

  // ── Esporte ──
  { cat: 'Esporte',        kws: ['futebol', 'society', 'quadra de', 'aluguel de quadra', 'beach tennis', 'futevolei', 'volei',
      'basquete', 'jiu jitsu', 'jiujitsu', 'muay thai', 'karate', 'judo', 'natacao', 'tenis '] },

  // ── Assinaturas / Streaming (marcas) ──
  { cat: 'Netflix',        kws: ['netflix'] },
  { cat: 'Spotify',        kws: ['spotify'] },
  { cat: 'Disney+',        kws: ['disney'] },
  { cat: 'Prime Video',    kws: ['prime video', 'primevideo', 'amazon prime'] },
  { cat: 'HBO Max',        kws: ['hbomax', 'hbo max', 'hbo', 'max stream'] },
  { cat: 'Globo Play',     kws: ['globoplay', 'globo play'] },
  { cat: 'Assinaturas',    kws: ['youtube premium', 'youtube music', 'deezer', 'tidal', 'apple music', 'apple com bill', 'apple.com bill',
      '=canva', 'notion', 'chatgpt', 'openai', 'midjourney', 'adobe', 'office 365', 'microsoft 365', 'google one', 'icloud',
      'paramount', 'crunchyroll', 'star plus', 'starplus', 'mubi', 'telecine', 'dropbox', 'linkedin premium', 'assinatura',
      // Ferramentas de IA/dev cobradas por mês. Vinham como "Outros" porque não
      // existiam aqui. Keywords curtas ou que são pedaço de palavra comum vão
      // com '=' (palavra inteira): '=claude' senão casa "Claudete"/"Claudia",
      // '=canva' senão casa "canvas", '=cursor'/'=grok' porque são genéricas.
      'anthropic', '=claude', 'claude ai', 'claude sub', 'lovable', 'cursor ai', '=cursor',
      'github copilot', 'copilot', 'perplexity', 'elevenlabs', 'runway ml', 'heygen',
      'replit', 'vercel', 'netlify', 'figma', 'framer', 'capcut', 'gemini advanced', 'google ai',
      'v0 dev', 'windsurf', 'supabase', 'railway app'] },

  // ── Saúde (Farmácia, Plano, Dentista, Psicólogo, Exames, Consultas) ──
  { cat: 'Plano de Saúde', kws: ['unimed', 'amil', 'hapvida', 'notredame', 'paz eterna', 'sulamerica', 'sul america',
      'golden cross', 'prevent senior', 'porto seguro saude', 'bradesco saude', 'plano de saude'] },
  { cat: 'Dentista',       kws: ['dentista', 'odontolog', 'odonto'] },
  { cat: 'Psicólogo',      kws: ['psicolog', 'psiquiatra', 'terapia', 'terapeuta'] },
  { cat: 'Exames',         kws: ['exame', 'laboratorio', 'fleury', 'sabin', 'hermes pardini', 'raio x', 'ultrassom', 'ressonancia', 'tomografia'] },
  { cat: 'Farmácia',       kws: ['farmacia', 'drogaria', 'drogasil', 'droga raia', 'pacheco', 'pague menos', 'panvel', 'raia ',
      'extrafarma', 'venancio', 'nissei', 'ultrafarma', 'remedio'] },
  { cat: 'Consultas',      kws: ['otorrino', 'fisioterap', 'cardiolog', 'ortoped', 'pediatra', 'ginecolog', 'urolog', 'oftalmo',
      'neurolog', 'endocrino', 'reumatolog', 'clinico geral', 'consulta medica', 'medico', 'hospital', 'clinica'] },
  { cat: 'Saúde',          kws: ['nutricionista', 'nutrolog', 'vacina', 'otica', 'oculos'] },

  // ── Família / Pet ──
  { cat: 'Pets',           kws: ['petz', 'cobasi', 'petlove', 'veterinari', 'pet shop', 'petshop', 'pet center', 'clinipet', 'agropet', '=racao'] },
  { cat: 'Família',        kws: ['fralda', 'creche', 'bercario', 'mesada', 'escolinha', 'brinquedo', 'ri happy', 'pbkids'] },

  // ── Educação ──
  { cat: 'Educação',       kws: ['udemy', 'coursera', 'alura', 'duolingo', 'rocketseat', 'hotmart', 'escola', 'colegio',
      'faculdade', 'universidade', 'uninter', 'estacio', 'anhanguera', 'qconcursos', 'gran cursos', 'mensalidade escolar',
      'livraria', 'saraiva', 'papelaria', 'kumon', 'wizard', 'ccaa', 'fisk', 'cna ', 'curso de'] },

  // ── Lazer ──
  // 'Cinema' é subcategoria canônica (🎬, sql/087) e as marcas caíam todas no
  // pai 'Lazer' — a quebra que a taxonomia promete nunca acontecia. Medido: 10
  // lançamentos com nome de cinema saem de Lazer e vêm pra cá.
  //
  // ⚠️ 'veloc' entra CRU (não 'veloc tickets') porque o descritor trunca. É
  // seguro porque 'velocidade' e 'velocity' têm ZERO ocorrências na base — e é
  // exatamente por isso que nenhuma academia "Velocity" foi pra lista de
  // Academia lá em cima: ela cairia aqui.
  { cat: 'Cinema',         kws: ['cinema', 'cinemark', 'kinoplex', 'cinepolis', 'uci cinemas', 'veloc'] },
  { cat: 'Lazer',          kws: ['ingresso', 'sympla', 'eventim', 'show ', 'teatro',
      'parque', 'hopi hari', 'beto carrero', 'steam', 'playstation', 'xbox', 'nintendo', 'riot games', 'epic games', 'twitch',
      'boliche', 'balada', 'bar ', 'pub ', 'cervejaria', 'festa', 'evento'] },

  // ── Viagem → subcategoria de Lazer ("Viagem") ──
  { cat: 'Viagem',         kws: ['latam', 'gol linhas', 'azul linhas', 'azul viagens', 'smiles', 'decolar', '123 milhas',
      'cvc ', 'maxmilhas', 'expedia', 'hoteis com', 'airbnb', 'booking', 'hotel', 'pousada', 'hostel', 'resort',
      'rentcars', 'localiza', 'movida', 'unidas', 'rent a car'] },

  // ── Tecnologia (telecom/celular/cloud) ──
  { cat: 'Tecnologia',     kws: ['vivo fibra', 'vivo ', 'claro net', 'claro ', 'oi fibra', 'tim sa', 'tim celular', 'net servicos',
      'sky ', 'telefonica', 'recarga celular', 'google play', 'app store', 'aws ', 'google cloud', 'azure', 'godaddy', 'hostgator', 'hostinger'] },

  // ── Moradia (contas de casa → subcategorias) ──
  { cat: 'Internet',       kws: ['internet', 'banda larga', 'fibra otica', 'tv por assinatura'] },
  { cat: 'Conta de Luz',   kws: ['enel', 'cpfl', 'light ', 'cemig', 'copel', 'celpe', 'coelba', 'energisa', 'equatorial energia',
      'elektro', 'energia eletrica', 'conta de luz', 'conta de energia', 'energia'] },
  { cat: 'Água',           kws: ['sabesp', 'cedae', 'copasa', 'sanepar', 'caesb', 'embasa', 'conta de agua', 'saneamento'] },
  { cat: 'Gás',            kws: ['comgas', 'gas natural', 'ultragaz', 'liquigas', 'botijao', 'gas de cozinha'] },
  { cat: 'Condomínio',     kws: ['condominio', 'taxa condominio'] },
  { cat: 'IPTU',           kws: ['iptu'] },
  { cat: 'Aluguel',        kws: ['aluguel', 'imobiliaria', 'quintoandar', 'quinto andar', 'locacao imovel'] },
  { cat: 'Moradia',        kws: ['construtora', 'leroy merlin', 'telhanorte', 'tok stok', 'madeira madeira', 'mobly',
      'casa bahia moveis', 'material de construcao', 'reforma'] },

  // ── Financeiro (juros, tarifas, impostos, empréstimos) ──
  { cat: 'Financiamento',  kws: ['financiamento', 'consorcio', 'prestacao veiculo'] },
  { cat: 'Financeiro',     kws: ['darf', 'ipva', 'imposto', 'receita federal', 'detran', 'multa de transito', 'tarifa bancaria',
      'tarifa mensal', 'anuidade cartao', 'iof', 'juros', 'emprestimo', 'previdencia', 'consignado'] },

  // ── Seguros → Seguro do veículo / genérico ──
  { cat: 'Seguro do veículo', kws: ['seguro auto', 'seguro do carro', 'seguro veicular', 'porto seguro auto'] },
  { cat: 'Seguro',         kws: ['seguro de vida', 'seguro residencial', 'seguro viagem', 'apolice', 'porto seguro', 'azul seguros',
      'sulamerica seguro', 'bradesco seguros', 'allianz', 'mapfre', 'tokio marine', 'seguro'] },

  // ── Doações ──
  { cat: 'Doações',        kws: ['dizimo', 'oferta igreja', 'doacao', 'vakinha', 'vaquinha', 'apae', 'cruz vermelha'] },

  // ── Compras genérico (fallback antes de Outros) ──
  { cat: 'Compras',        kws: ['presente', 'lembrancinha', 'shopping', 'loja de departamento'] },

  // ── Salário / Renda ──
  { cat: 'Salário',        kws: ['salario', 'folha de pagamento', 'folha pagamento', 'pro labore', 'pro-labore', 'provento', 'remuneracao', 'decimo terceiro'] },

  // ── Negócio (receita de vendas/serviços) ──
  { cat: 'Negócio',        kws: ['venda de', 'recebi de cliente', 'freelance', 'freela', 'consultoria', 'prestacao de servico'] },

  // ── Investimentos (receita) ──
  { cat: 'Investimentos',  kws: ['dividendo', 'rendimento', 'aplicacao', 'resgate', 'tesouro direto', 'corretora', 'xp investimentos', 'nuinvest', 'aporte', 'renda fixa', 'fundo de investimento', 'b3 '] },
];

// Nome da categoria sugerida pela descrição, ou null.
function categorizarDescricao(descricao) {
  const t = normalizar(descricao);
  if (!t) return null;
  for (const regra of REGRAS) {
    for (const kw of regra.kws) {
      // normalizar() comeria o '=' (vira espaço) — reaplica depois pra manter
      // o pedido de "palavra inteira".
      const exato = kw[0] === '=';
      const k = normalizar(kw);
      if (k && casa(t, exato ? `=${k}` : k)) return regra.cat;
    }
  }
  return null;
}

// Fallback: taxonomia do próprio Pluggy (tx.category, em inglês/PT) → Sora.
// Avaliado por substring no nome normalizado da categoria do Pluggy.
const MAPA_PLUGGY = [
  { cat: 'Supermercado',   kws: ['supermarket', 'groceries', 'grocery', 'mercado', 'supermercado'] },
  { cat: 'Restaurante',    kws: ['food and drinks', 'food & drinks', 'restaurant', 'fast food', 'bars', 'dining', 'aliment', 'restaurante', 'comida', 'bares'] },
  { cat: 'Café',           kws: ['coffee', 'cafe'] },
  { cat: 'Delivery',       kws: ['food delivery', 'delivery'] },
  { cat: 'Combustível',    kws: ['gas station', 'fuel', 'combustivel', 'gasolina'] },
  { cat: 'Transporte',     kws: ['transport', 'public transportation', 'parking', 'tolls', 'transporte', 'pedagio', 'estacionamento'] },
  { cat: 'Uber',           kws: ['ride hailing', 'ride-hailing', 'taxi', 'uber'] },
  { cat: 'Consultas',      kws: ['doctor', 'medical'] },
  { cat: 'Farmácia',       kws: ['pharmacy', 'drugstore', 'farmacia'] },
  { cat: 'Saúde',          kws: ['health', 'saude', 'medico'] },
  { cat: 'Autocuidado',    kws: ['beauty', 'personal care', 'cosmetic', 'beleza', 'estetica'] },
  { cat: 'Academia',       kws: ['gym', 'fitness', 'academia'] },
  { cat: 'Compras',        kws: ['clothing', 'apparel', 'fashion', 'shoes', 'vestuario', 'roupa', 'calcado', 'shopping', 'electronics', 'eletronicos'] },
  { cat: 'Assinaturas',    kws: ['streaming', 'subscription', 'digital services', 'software', 'assinatura'] },
  { cat: 'Lazer',          kws: ['leisure', 'entertainment', 'gaming', 'games', 'lazer', 'entreten', 'jogos'] },
  { cat: 'Viagem',         kws: ['travel', 'airline', 'airlines', 'hotel', 'lodging', 'accommodation', 'viagem', 'hospedagem', 'passagens'] },
  { cat: 'Educação',       kws: ['education', 'school', 'tuition', 'courses', 'educacao', 'escola', 'curso'] },
  { cat: 'Pets',           kws: ['pet', 'pets', 'veterinary'] },
  { cat: 'Tecnologia',     kws: ['telecommunication', 'phone', 'mobile', 'internet', 'telefon', 'celular'] },
  { cat: 'Conta de Luz',   kws: ['utilities', 'electricity', 'bills', 'energia', 'luz', 'contas'] },
  { cat: 'Água',           kws: ['water', 'agua'] },
  { cat: 'Gás',            kws: ['gas'] },
  { cat: 'Moradia',        kws: ['rent', 'housing', 'home improvement', 'aluguel', 'moradia', 'casa', 'condominio'] },
  { cat: 'Financeiro',     kws: ['tax', 'taxes', 'government', 'imposto', 'tributo', 'fees', 'interest', 'juros', 'insurance', 'seguro'] },
  { cat: 'Investimentos',  kws: ['investment', 'investments', 'investimento', 'aplicacao', 'dividend', 'dividendo'] },
  { cat: 'Transferências', kws: ['transfer', 'transfers', 'pix', 'ted', 'doc', 'transferencia', 'wire'] },
  { cat: 'Salário',        kws: ['salary', 'income', 'payroll', 'wages', 'salario', 'renda', 'provento'] },
  { cat: 'Encomendas',     kws: ['online shopping', 'e-commerce', 'ecommerce', 'marketplace', 'compras'] },
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
// Categorias que só fazem sentido como ENTRADA → o par de saída.
const SO_RECEITA = { PIX: 'Pix enviado' };

/**
 * Corrige a categoria pela DIREÇÃO do lançamento.
 *
 * O motor de palavras-chave olha só a descrição, e "Pix enviado" e "Pix
 * recebido" casam na mesma regra → os dois caíam em `PIX`, que na taxonomia é
 * categoria de RECEITA. Um Pix que SAI ficava com categoria de entrada.
 *
 * O dinheiro nunca sumiu: Transações e Relatórios somam por `tipo`, então a
 * saída sempre contou como despesa. Quem escondia era a aba CATEGORIAS, que
 * lista as categorias de despesa e não achava `PIX` entre elas. Medido: 1.106
 * lançamentos de Gasto com essa categoria na base, e `PIX` é de receita nos
 * 141 grupos — não era caso isolado.
 *
 * ⚠️ O DESTINO PRECISA EXISTIR NA TAXONOMIA. O campo `categoria` é texto
 * livre, e um nome que não é categoria cadastrada some da aba do mesmo jeito —
 * seria trocar um bug pelo outro. `Pix enviado` é criada pela migration 132 em
 * todos os grupos, pendurada em Financeiro.
 */
function ajustarPorDirecao(categoria, ehGasto) {
  if (!ehGasto || !categoria) return categoria;
  return SO_RECEITA[categoria] || categoria;
}

function categorizar({ descricao, pluggyCategoria, ehGasto } = {}) {
  const cat = categorizarDescricao(descricao) || mapearCategoriaPluggy(pluggyCategoria) || 'Outros';
  return ajustarPorDirecao(cat, ehGasto);
}

// ── Pagamento de fatura do cartão ───────────────────────────────────────────
// Subcategoria de Financeiro (migration 103). Antes era a string solta
// 'Fatura cartão', repetida em ~18 arquivos — mudar de nome exigia achar todas,
// e esquecer UMA faz o pagamento voltar a contar como gasto no relatório
// (contaria em DOBRO: as compras da fatura já foram categorizadas uma a uma).
const CATEGORIA_FATURA = 'Fatura';
const CATEGORIA_FATURA_LEGADO = 'Fatura cartão';

// Crédito na fatura que NÃO é pagamento: estorno, cashback, "Crédito de
// parcelamento de compra", ajuste do emissor. Existe pra separar do
// CATEGORIA_FATURA — antes tudo que era crédito no cartão saía como 'Fatura' e
// o estorno não abatia a fatura (ver services/valorFatura.js). Já existe na
// taxonomia v4 como subcategoria ↩️ (sql/087), então não precisa de migration.
const CATEGORIA_ESTORNO = 'Reembolso';

/** É pagamento de fatura? Aceita o nome novo e o legado (histórico não reescrito). */
function ehPagamentoFatura(categoria) {
  const c = (categoria || '').toString().trim().toLowerCase();
  return c === CATEGORIA_FATURA.toLowerCase() || c === CATEGORIA_FATURA_LEGADO.toLowerCase();
}

/**
 * Pagamento de fatura visto pelo lado da CONTA, detectado pela descrição.
 *
 * ⚠️ FONTE ÚNICA — não copiar esta regra pra dentro de um sync. Ela já existia
 * só no trilho Pluggy (services/pluggySync.js) e NÃO foi portada pro trilho
 * Celcoin; resultado: "Pagamento Cartão de crédito" (R$ 2.243,60, conta do
 * Mercado Pago) entrou como Gasto/Outros e voltou a inflar o relatório e o
 * gráfico por categoria — o bug que já tinha sido corrigido uma vez.
 *
 * Por que importa: a fatura é paga UMA vez mas aparece nos DOIS lados — sai da
 * conta e abate no cartão. Contar o pagamento como gasto conta em dobro, já
 * que cada compra da fatura já foi categorizada uma a uma.
 *
 * Exige palavra de PAGAMENTO **e** de cartão/fatura juntas: "pagamento pix" ou
 * "cartao de credito" sozinhos não podem virar transferência.
 */
// `(?:d[aeo]s?\s+)?` cobre "de", "da", "do", "das", "dos" e a ausência deles:
// os bancos escrevem "Pagamento DE fatura", "Pagamento DA fatura" e
// "Pagamento fatura". Faltar o "da" já deixou "Pagamento da fatura" passar.
const PAGA = '(?:pagamento|pagto|pgto|pag)\\s+(?:d[aeo]s?\\s+)?';
// ⚠️ DÉBITO AUTOMÁTICO também é forma de PAGAR — e é como o Itaú descreve a
// quitação da fatura: "Débito automático FATURA ITAU PERSON MC BLACK". Sem
// isto o pagamento entrava como gasto comum e contava EM DOBRO, já que cada
// compra da fatura já foi categorizada uma a uma. Medido num cliente real:
// 5 linhas, R$ 30.896,16 inflando os gastos — R$ 13.123,09 num mês só.
//
// ⚠️ `\\s*` antes de fatura/cart de propósito: o extrato do Itaú às vezes vem
// com as palavras GRUDADAS ("Débito automático FATURAITAU UNICLASS V").
const DEB_AUTO = '(?:debito|deb)\\s+(?:automatico|automat|autom|aut)\\.?\\s*(?:d[aeo]s?\\s+)?';
const RE_PAGAMENTO_FATURA = new RegExp([
  `${PAGA}fatura`,
  `${PAGA}cart`,
  // ⚠️ Continua exigindo fatura/cartão JUNTO — "Débito automático AMIL
  // ASSISTENCIA MEDICA" e "Débito automático - Icatu seguros" são débito
  // automático de verdade (plano de saúde, seguro) e NÃO podem virar
  // transferência. Medido: 21 das 26 linhas com "débito automático" na base
  // são desse tipo, e seguem intocadas.
  `${DEB_AUTO}fatura`,
  `${DEB_AUTO}cart`,
  'fatura\\s+(?:d[aeo]s?\\s+)?cart',
  'credit\\s*card\\s*payment',
].join('|'));

function ehPagamentoFaturaDescricao(descricao, categoriaExterna) {
  const s = `${descricao || ''} ${categoriaExterna || ''}`
    .toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return RE_PAGAMENTO_FATURA.test(s);
}

// ── APLICAR / RESGATAR não é gastar nem ganhar ──────────────────────────────
//
// O critério é UM só: **o patrimônio muda?**
//   · aplicar R$ 1.000 num CDB → o dinheiro sai do bolso "conta" e entra no
//     bolso "investimento". Patrimônio IGUAL → transferência.
//   · resgatar → o caminho de volta. Patrimônio IGUAL → transferência.
//   · rendimento, juros, dividendo, JCP → patrimônio AUMENTA → é RECEITA.
//   · IR, IOF, come-cotas → patrimônio DIMINUI → é DESPESA.
//
// Medido na base (ago/2026): 264 aplicações contavam R$ 126.769 como DESPESA e
// 409 resgates contavam R$ 101.377 como RECEITA. Quem usa Cofrinho do Inter ou
// CDB de liquidez diária via o relatório inteiro distorcido — um cliente tinha
// 132 aplicações, com o dinheiro entrando e saindo da mesma conta o mês todo,
// inflando os dois lados a cada ciclo.
//
// ⚠️ AS EXCLUSÕES SÃO O CORAÇÃO DESTA REGRA, não um detalhe.
// "REMUNERACAO APLICACAO AUTOMATICA" e "RENTAB.INVEST FACIL" contêm a palavra
// "aplicação" mas são RENDIMENTO — renda de verdade. Sem barrá-las, esta função
// transformaria receita em transferência e apagaria o ganho do usuário.
// Medido: 20 linhas de "REMUNERACAO APLICACAO" na base.
// ⚠️ IMPOSTO TAMBÉM ENTRA AQUI, e foi a simulação que me mostrou isso: a base
// tem "IRRF S/RESGATE FUNDOS", "IR - RESGATE CDB..." e "IOF - RESGATE CDB...".
// Todas contêm a palavra "resgate" e eu as teria transformado em transferência
// — mas imposto é DESPESA de verdade: o patrimônio diminui e o dinheiro não
// volta. Mesma lógica do rendimento, com o sinal trocado.
//
// "ajuste" também: correção de saldo tem fluxo próprio (🔧 Ajuste) e virar
// transferência a esconderia do usuário.
const RE_RENDA_INVEST = new RegExp([
  // renda (patrimônio AUMENTA)
  'remuneracao', 'rentab', 'rendiment', '\\brend\\b', 'juros',
  'dividend', 'jcp', 'jscp', 'provento', 'estorno',
  // imposto/taxa (patrimônio DIMINUI)
  'irrf', '\\bir\\b', '\\biof\\b', 'imposto', 'come.?cotas', 'tributo', 'taxa',
  // correção de saldo — não é movimentação de investimento
  'ajuste',
].join('|'));

// ⚠️ `\b` OBRIGATÓRIO antes de "aplicac"/"resgate". Sem ele, "PassAPORTE ROTA
// BIKER" casava com "aporte" — um passeio de bicicleta virava movimentação de
// investimento (caso real na base).
const RE_MOV_INVEST = /\b(aplicac|resgate|liquidac|aporte)/;

/**
 * A descrição é APLICAÇÃO ou RESGATE de investimento?
 *
 * Só isso — rendimento, dividendo e imposto NÃO entram, porque esses de fato
 * mudam o patrimônio e devem seguir contando como receita/despesa.
 *
 * ⚠️ Quem chama precisa garantir que a carteira NÃO é cartão de crédito. Não
 * existe "aplicar" a partir de um cartão, e marcar transferência em carteira de
 * crédito mexe no cálculo da fatura (`valorFatura.valorNaFatura`).
 */
function ehMovimentoInvestimento(descricao, categoriaExterna) {
  const s = `${descricao || ''} ${categoriaExterna || ''}`
    .toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (RE_RENDA_INVEST.test(s)) return false;   // rendimento/dividendo/imposto vencem
  return RE_MOV_INVEST.test(s);
}

module.exports = {
  ajustarPorDirecao,
  categorizar, categorizarDescricao, mapearCategoriaPluggy,
  CATEGORIA_FATURA, CATEGORIA_FATURA_LEGADO, CATEGORIA_ESTORNO,
  ehPagamentoFatura, ehPagamentoFaturaDescricao, ehMovimentoInvestimento,
};
