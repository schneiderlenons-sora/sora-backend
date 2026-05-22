// ─────────────────────────────────────────────────────────────────
// Sora · Nutrição
// - Banco local de alimentos brasileiros (TACO)
// - Parser de refeição via Claude Haiku (IA)
// - Calculadora TMB / TDEE / macros
// - Diagnóstico nutricional do dia
// ─────────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const ALIMENTOS = require('../data/alimentos.json');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Normaliza string (lower + sem acento)
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// ── BANCO LOCAL: busca alimento por nome/alias ──────────────────
function lookupLocal(termo) {
  if (!termo) return null;
  const t = norm(termo);
  // Match exato em nome ou alias
  for (const a of ALIMENTOS) {
    if (norm(a.nome) === t) return a;
    if ((a.aliases || []).some(al => norm(al) === t)) return a;
  }
  // Match parcial (contém)
  for (const a of ALIMENTOS) {
    if (norm(a.nome).includes(t) || t.includes(norm(a.nome))) return a;
    if ((a.aliases || []).some(al => norm(al).includes(t) || t.includes(norm(al)))) return a;
  }
  return null;
}

function buscarAlimentos(q) {
  if (!q) return ALIMENTOS.slice(0, 20);
  const t = norm(q);
  return ALIMENTOS.filter(a =>
    norm(a.nome).includes(t) || (a.aliases || []).some(al => norm(al).includes(t))
  ).slice(0, 20);
}

// Calcula macros pra uma quantidade em gramas dado um alimento
function macrosParaQuantidade(alimento, gramas) {
  const f = gramas / 100;
  return {
    nome:           alimento.nome,
    quantidade_g:   Math.round(gramas),
    porcao_descr:   alimento.porcao?.descricao || null,
    calorias:       +(alimento.kcal_100 * f).toFixed(1),
    proteinas_g:    +(alimento.p_100 * f).toFixed(1),
    carboidratos_g: +(alimento.c_100 * f).toFixed(1),
    gorduras_g:     +(alimento.g_100 * f).toFixed(1),
    fonte:          'local',
  };
}

// ── PARSER DE REFEIÇÃO via IA ───────────────────────────────────
async function analisarRefeicaoIA(texto) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurada no servidor.');
  }

  const sysPrompt = `Você é nutricionista. Analise a refeição em português brasileiro e retorne APENAS um JSON válido (sem texto antes ou depois).

Formato exato:
{
  "itens": [
    {
      "nome": "string",
      "quantidade_g": number,
      "porcao_descr": "string (ex: '2 conchas', '1 filé')",
      "calorias": number,
      "proteinas_g": number,
      "carboidratos_g": number,
      "gorduras_g": number
    }
  ]
}

PORÇÕES PADRÃO (quando o usuário não especificar quantidade exata):
- 1 concha de arroz = 80g | 1 concha de feijão = 90g
- 1 bife/filé de carne = 100g | 1 filé de frango = 150g
- 1 ovo = 50g | 1 fatia de pão de forma = 25g | 1 pão francês = 50g
- 1 xícara = 200ml | 1 copo = 200ml | 1 colher de sopa = 15g
- 1 fatia de queijo = 20-30g | 1 unidade média de fruta = 100-150g
- "punhado", "porção" pequena = 30-50g

Use valores TACO/USDA. Seja conservador em estimativas. Calorias = (4*proteinas) + (4*carbo) + (9*gorduras).
Se a frase do usuário não contém comida (ex: "oi", "teste"), retorne {"itens": []}.`;

  let resp;
  try {
    resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: sysPrompt,
      messages: [{ role: 'user', content: texto }],
    });
  } catch (err) {
    console.error('[nutricao] chamada Claude falhou:', err.status, err.message, err.error);
    throw new Error(`IA indisponível: ${err.message}`);
  }

  const raw = (resp.content?.[0]?.text || '').trim().replace(/```json|```/g, '').trim();

  // Extrai o primeiro bloco JSON da resposta (caso a IA inclua texto extra)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[nutricao] resposta sem JSON válido:', raw.slice(0, 300));
    throw new Error('IA retornou formato inesperado.');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[nutricao] JSON.parse falhou:', err.message, 'raw:', raw.slice(0, 300));
    throw new Error('Não consegui ler a resposta da IA.');
  }

  return (parsed.itens || []).map(i => ({
    nome:           i.nome,
    quantidade_g:   parseFloat(i.quantidade_g) || null,
    porcao_descr:   i.porcao_descr || null,
    calorias:       parseFloat(i.calorias) || 0,
    proteinas_g:    parseFloat(i.proteinas_g) || 0,
    carboidratos_g: parseFloat(i.carboidratos_g) || 0,
    gorduras_g:     parseFloat(i.gorduras_g) || 0,
    fonte:          'ia',
  }));
}

// Fallback local: quebra o texto por vírgulas/"e"/"com"/"+" e tenta match no banco TACO.
// Detecta quantidade tipo "2 conchas", "1 fatia", "100g", "1 unidade".
function analisarLocalFallback(texto) {
  const fragmentos = (texto || '')
    .split(/,| e | com |\+|\bmais\b/i)
    .map(s => s.trim())
    .filter(Boolean);

  const itens = [];
  for (const frag of fragmentos) {
    // Match local pelo fragmento inteiro primeiro (ex: "arroz branco")
    let alimento = lookupLocal(frag);
    let porcaoStr = null;
    let gramas = null;

    // Tenta extrair quantidade explícita em gramas (ex: "150g de arroz")
    const mG = frag.match(/(\d+(?:[.,]\d+)?)\s*g(?:r(?:amas?)?)?\b/i);
    if (mG) {
      gramas = parseFloat(mG[1].replace(',', '.'));
      porcaoStr = `${gramas}g`;
    }

    // Tenta extrair quantidade em unidades padrão (ex: "2 conchas", "1 fatia")
    const mUnid = frag.match(/(\d+(?:[.,]\d+)?)\s*(concha|fatia|copo|x[íi]cara|colher|unidade|filé|file|bife|ovo|p[ãa]o)s?\b/i);
    if (mUnid && !gramas) {
      const qtd = parseFloat(mUnid[1].replace(',', '.'));
      porcaoStr = `${qtd} ${mUnid[2]}${qtd > 1 ? 's' : ''}`;
      // Busca o alimento removendo a parte da quantidade
      const semQtd = frag.replace(mUnid[0], '').trim();
      alimento = lookupLocal(semQtd) || lookupLocal(frag);
      // Multiplica a porção padrão do alimento pela quantidade
      if (alimento?.porcao?.g) gramas = alimento.porcao.g * qtd;
    }

    // Se ainda sem alimento, tenta lookup palavra a palavra (pega a primeira que bater)
    if (!alimento) {
      for (const palavra of frag.split(/\s+/)) {
        if (palavra.length < 3) continue;
        alimento = lookupLocal(palavra);
        if (alimento) break;
      }
    }

    // Se achou alimento mas sem gramas, usa a porção padrão
    if (alimento && !gramas) {
      gramas = alimento.porcao?.g || 100;
      porcaoStr = porcaoStr || alimento.porcao?.descricao;
    }

    if (alimento && gramas) {
      itens.push({ ...macrosParaQuantidade(alimento, gramas), porcao_descr: porcaoStr || alimento.porcao?.descricao });
    }
  }
  return itens;
}

// Parser híbrido: tenta IA primeiro; se falhar OU retornar vazio, cai pro banco local.
async function analisarRefeicao(texto) {
  let itensIA = [];
  let erroIA = null;
  try {
    itensIA = await analisarRefeicaoIA(texto);
  } catch (err) {
    erroIA = err;
    console.error('[nutricao] IA falhou, tentando fallback local:', err.message);
  }

  // Sucesso da IA: enriquece com banco local quando casar
  if (itensIA.length) {
    return itensIA.map(item => {
      const local = lookupLocal(item.nome);
      if (local && item.quantidade_g) {
        return { ...macrosParaQuantidade(local, item.quantidade_g), porcao_descr: item.porcao_descr || local.porcao?.descricao };
      }
      if (!item.nome || (!item.quantidade_g && !item.calorias)) return null;
      return item;
    }).filter(Boolean);
  }

  // IA não trouxe itens (ou falhou) — tenta parser local puro
  const itensLocal = analisarLocalFallback(texto);
  if (itensLocal.length) return itensLocal;

  // Nem IA nem local conseguiram — propaga o erro real da IA se houver
  if (erroIA) throw erroIA;
  return [];
}

// ── CALCULADORA TMB / TDEE / MACROS ──────────────────────────────
const FATOR_ATIVIDADE = {
  sedentario: 1.2,
  leve:       1.375,
  moderado:   1.55,
  intenso:    1.725,
  atleta:     1.9,
};

const DIETAS = {
  // [proteinas%, carbos%, gorduras%]
  padrao:        [0.30, 0.45, 0.25],
  low_carb:      [0.35, 0.25, 0.40],
  cetogenica:    [0.25, 0.10, 0.65],
  hipercalorica: [0.25, 0.55, 0.20],
  vegetariana:   [0.25, 0.50, 0.25],
  vegana:        [0.22, 0.55, 0.23],
};

function calcularIdade(dataNascimento) {
  if (!dataNascimento) return null;
  const nasc = new Date(dataNascimento);
  const hoje = new Date();
  let idade = hoje.getFullYear() - nasc.getFullYear();
  const m = hoje.getMonth() - nasc.getMonth();
  if (m < 0 || (m === 0 && hoje.getDate() < nasc.getDate())) idade--;
  return idade;
}

function calcularMetas({ peso_kg, altura_cm, idade, sexo, nivel_atividade, objetivo, tipo_dieta }) {
  if (!peso_kg || !altura_cm || !idade) {
    throw new Error('Peso, altura e idade são obrigatórios.');
  }

  // TMB Mifflin-St Jeor
  let tmb;
  if (sexo === 'M') tmb = 10 * peso_kg + 6.25 * altura_cm - 5 * idade + 5;
  else              tmb = 10 * peso_kg + 6.25 * altura_cm - 5 * idade - 161;

  const fator = FATOR_ATIVIDADE[nivel_atividade] || FATOR_ATIVIDADE.moderado;
  const tdee  = tmb * fator;

  // Ajuste calórico pelo objetivo
  const ajustes = { emagrecer: -500, manter: 0, ganhar_massa: +400, definicao: -300 };
  const calorias = Math.round(tdee + (ajustes[objetivo] ?? 0));

  // Split de macros
  const [pP, pC, pG] = DIETAS[tipo_dieta] || DIETAS.padrao;
  const proteinas_g    = Math.round((calorias * pP) / 4);
  const carboidratos_g = Math.round((calorias * pC) / 4);
  const gorduras_g     = Math.round((calorias * pG) / 9);

  // Água: 35ml por kg
  const agua_ml = Math.round(peso_kg * 35);

  return {
    tmb:  Math.round(tmb),
    tdee: Math.round(tdee),
    calorias, proteinas_g, carboidratos_g, gorduras_g, agua_ml,
  };
}

// ── DIAGNÓSTICO NUTRICIONAL DO DIA ──────────────────────────────
function gerarDiagnostico(macrosHoje, meta) {
  if (!meta || !macrosHoje) return null;
  const itens = [];

  const cal_pct = meta.calorias ? (macrosHoje.calorias / meta.calorias) : 0;
  const pro_pct = meta.proteinas_g ? (macrosHoje.proteinas_g / meta.proteinas_g) : 0;
  const car_pct = meta.carboidratos_g ? (macrosHoje.carboidratos_g / meta.carboidratos_g) : 0;
  const gor_pct = meta.gorduras_g ? (macrosHoje.gorduras_g / meta.gorduras_g) : 0;

  const horaAtual = new Date().getHours();
  const tarde = horaAtual >= 14;

  // Proteína baixa
  if (pro_pct < 0.6 && tarde) {
    itens.push({
      severidade: 'aviso',
      emoji: '🥚',
      titulo: 'Proteína baixa hoje',
      texto: `Você ingeriu ${Math.round(macrosHoje.proteinas_g)}g de ${meta.proteinas_g}g. Que tal um ovo, frango ou whey pra completar?`,
    });
  } else if (pro_pct >= 0.95) {
    itens.push({
      severidade: 'sucesso',
      emoji: '💪',
      titulo: 'Proteína bem distribuída',
      texto: 'Você bateu a meta proteica do dia — ótimo pra recuperação muscular.',
    });
  }

  // Calorias muito baixas (risco de déficit severo)
  if (cal_pct < 0.5 && tarde && macrosHoje.calorias > 0) {
    itens.push({
      severidade: 'aviso',
      emoji: '⚠️',
      titulo: 'Consumo muito abaixo da meta',
      texto: `Você consumiu apenas ${Math.round(macrosHoje.calorias)} kcal de ${meta.calorias}. Déficits extremos prejudicam metabolismo e massa magra.`,
    });
  }

  // Carbos altos
  if (car_pct > 1.15) {
    itens.push({
      severidade: 'info',
      emoji: '🍞',
      titulo: 'Carbos acima da meta',
      texto: `${Math.round(macrosHoje.carboidratos_g)}g vs meta ${meta.carboidratos_g}g. Considere ajustar nas próximas refeições.`,
    });
  }

  // Gorduras altas
  if (gor_pct > 1.15) {
    itens.push({
      severidade: 'info',
      emoji: '🥑',
      titulo: 'Gorduras acima da meta',
      texto: `${Math.round(macrosHoje.gorduras_g)}g vs meta ${meta.gorduras_g}g.`,
    });
  }

  // Sem registros
  if (macrosHoje.calorias === 0) {
    itens.push({
      severidade: 'info',
      emoji: '📝',
      titulo: 'Nenhuma refeição registrada hoje',
      texto: 'Comece registrando o que você comeu — basta descrever em texto.',
    });
  }

  // Meta batida
  if (cal_pct >= 0.95 && cal_pct <= 1.1 && pro_pct >= 0.9) {
    itens.push({
      severidade: 'sucesso',
      emoji: '🎯',
      titulo: 'Dia equilibrado',
      texto: 'Calorias e proteína na faixa ideal. Mantenha o ritmo!',
    });
  }

  return itens;
}

module.exports = {
  lookupLocal,
  buscarAlimentos,
  macrosParaQuantidade,
  analisarRefeicao,
  calcularMetas,
  calcularIdade,
  gerarDiagnostico,
};
