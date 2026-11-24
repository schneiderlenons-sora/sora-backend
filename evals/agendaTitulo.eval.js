// =============================================================================
// EVAL — o TÍTULO do compromisso marcado pelo WhatsApp.
//
// Relato do Bruno (24/11/2026), com print:
//   1. "Pedi 'Reunião com Pedro dia 18/11 as 8h' e a IA anota só a primeira
//       letra maiúscula — ela poderia copiar exatamente como eu escrevi."
//   2. "marca santo antonio dia 29/11 as 8" salvou "Santo antonio DIA".
//
// Medido no handler real ANTES do conserto (mesmo simulador do §3):
//   "marca Reunião com Pedro dia 18/11 as 8h"  → "Reunião com pedro dia"
//   "marca jantar no dia 29/11 às 20h"         → "Jantar no dia"
//   "marca reunião na sexta com o Pedro às 10h"→ "Reunião na com o pedro"
//   "marca Festa da Ana dia 29 de novembro"    → "Festa da ana de novembro"
//   "marca futebol na quadra qua 20h"          → "Futebol na dra"  (!)
// e "dia 5 de janeiro" dito em novembro era gravado em 5 de DEZEMBRO.
//
// O que este eval trava:
//   §1 a regra de grafia (`grafiaPorPalavra`) sozinha;
//   §2 o "dia N de mês" no parser de data;
//   §3 o handler REAL, com banco e WhatsApp falsos — inclusive o caminho em que
//      a frase passa pela IA antes;
//   §4 ⚠️ que NENHUMA frase muda de rumo: o parser novo é comparado com a cópia
//      CONGELADA do antigo. "É data?" tem de dar igual SEMPRE (é o que decide
//      agenda × tarefa × nota), e sem mês escrito o resultado é idêntico.
//
// Rodar:  node evals/agendaTitulo.eval.js
// =============================================================================
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede'; // nada chama a OpenAI aqui
const path = require('path');

const falhas = [];
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── stubs: nada sai daqui (sem banco, sem WhatsApp, sem IA) ─────────────────
const SRC = path.join(__dirname, '..', 'src');
const stub = (p, exp) => { const f = require.resolve(path.join(SRC, p)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
let inserts = [], enviados = [], iaResposta = null;
const tabela = (nome) => {
  const st = { op: 'select', payload: null };
  const res = () => {
    if (st.op !== 'insert') return { data: null, error: null };
    const row = { id: 'novo', ...st.payload }; inserts.push({ nome, row }); return { data: row, error: null };
  };
  const p = new Proxy({}, {
    get(_, k) {
      if (k === 'then') return (a, b) => Promise.resolve(res()).then(a, b);
      if (k === 'insert') return (o) => { st.op = 'insert'; st.payload = o; return p; };
      if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(res());
      return () => p;
    },
  });
  return p;
};
stub('db/supabase.js', { from: tabela });
stub('services/mensageiro.js', {
  enviarTexto: async (_, t) => enviados.push(t), enviarImagem: async () => {},
  enviarBotaoLink: async (_, o) => enviados.push(o.message),
});
stub('services/growShare.js', { growShareCfg: async () => ({ casa: false }) });
stub('services/rotinaSync.js', { sincronizarCompromisso: async () => {} });
stub('services/ia.js', { interpretarGrowComando: async () => iaResposta });

const { grafiaPorPalavra } = require('../src/services/descricaoTx');
const handleGrow = require('../src/handlers/grow');
const { parseDataPt } = handleGrow;

const ctx = { phone: '5500000000000', grupoId: 'g', user: { id: 'u', plano: 'basico' } };
async function marcar(frase, ia = null) {
  inserts = []; enviados = []; iaResposta = ia;
  const log = console.log; console.log = () => {};          // o handler loga a tradução da IA
  try { await handleGrow(frase, ctx); } finally { console.log = log; }
  return inserts.find((i) => i.nome === 'compromissos')?.row || null;
}

// datas relativas a HOJE (o parser usa o relógio local)
const isoD = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const hoje0 = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const proximaVez = (mo, dd) => { // mo: 0..11 — a próxima vez que dd/mo acontece
  const y = new Date().getFullYear(); let d = new Date(y, mo, dd, 12);
  if (d < hoje0()) d = new Date(y + 1, mo, dd, 12);
  return isoD(d);
};

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 1. grafia palavra por palavra ──');
  {
    // trecho contínuo → a fatia original, com a pontuação de volta
    eq(grafiaPorPalavra('ligar pro dr carlos', 'me lembra de ligar pro Dr. Carlos sexta'), 'ligar pro Dr. Carlos', '§1 contínuo devolve o ponto do "Dr."');
    eq(grafiaPorPalavra('dr aluísio cardiologista', 'Dr.Aluísio Cardiologista, 25/09 às 10:00'), 'Dr.Aluísio Cardiologista', '§1 "Dr.Aluísio" colado');
    eq(grafiaPorPalavra('check up', 'marca check-up amanhã'), 'check-up', '§1 hífen volta');
    // data no MEIO → palavra a palavra (a fatia traria a data de volta)
    eq(grafiaPorPalavra('reunião com pedro', 'Reunião dia 18/11 com Pedro as 8h'), 'Reunião com Pedro', '⚠️ §1 data no meio não volta pro título');
    eq(grafiaPorPalavra('reunião com cliente', 'tenho uma Reunião com um Cliente amanhã'), 'Reunião com Cliente', '§1 palavra tirada no meio');
    // acento: vale o que a PESSOA escreveu
    eq(grafiaPorPalavra('santo antonio', 'marca Santo Antônio dia 29/11'), 'Santo Antônio', '§1 acento da pessoa');
    // texto colado com acento decomposto (o + U+0302)
    const decomposto = 'marca Santo Antônio dia 29/11';
    eq(grafiaPorPalavra('santo antônio', decomposto), 'Santo Antônio', '§1 acento decomposto não parte a palavra');
    // palavra que não existe no original fica como veio; nada é inventado
    eq(grafiaPorPalavra('dentista amanhã', 'marca Dentista'), 'Dentista amanhã', '§1 palavra ausente fica como veio');
    eq(grafiaPorPalavra('', 'qualquer'), '', '§1 vazio');
    eq(grafiaPorPalavra('reunião', ''), 'reunião', '§1 sem original');
    // EM ORDEM: o título nunca pega uma palavra de trás
    eq(grafiaPorPalavra('pedro e ana', 'Ana chamou: pedro e ANA'), 'pedro e ANA', '§1 alinhamento em ordem');
    // espaço/quebra de linha dentro da fatia vira um espaço
    eq(grafiaPorPalavra('reunião com pedro', 'Reunião\ncom   Pedro'), 'Reunião com Pedro', '§1 quebra de linha não entra no título');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 2. "dia N de mês" ──');
  {
    eq(parseDataPt('dia 5 de janeiro')?.iso, proximaVez(0, 5), '⚠️ §2 o mês escrito vale (era o mês do calendário)');
    eq(parseDataPt('dia 5 de janeiro')?.matched, 'dia 5 de janeiro', '§2 o mês sai junto do título');
    eq(parseDataPt('festa dia 29 de novembro as 20h')?.iso, proximaVez(10, 29), '§2 no meio da frase');
    eq(parseDataPt('dia 2 de março')?.iso, proximaVez(2, 2), '§2 "março" com ç');
    eq(parseDataPt('dia 2 de marco')?.iso, proximaVez(2, 2), '§2 "marco" sem ç');
    eq(parseDataPt('dia 10 de dezembro de 2027')?.iso, '2027-12-10', '§2 ano escrito');
    eq(parseDataPt('dia 10 de dezembro de 2027')?.matched, 'dia 10 de dezembro de 2027', '§2 o ano sai junto');
    // data que não existe → a regra antiga do "dia N" (sem mês)
    eq(parseDataPt('dia 31 de fevereiro')?.matched, 'dia 31', '§2 "31 de fevereiro" cai na regra antiga');
    // "de manhã/tarde" não é mês
    eq(parseDataPt('dia 20 de manhã')?.matched, 'dia 20', '§2 "de manhã" não é mês');
    // ⚠️ sem o "dia" não vira data: "Rua 25 de Março" é endereço
    eq(parseDataPt('compras na 25 de março'), null, '⚠️ §2 "25 de março" sem "dia" não é data');
    eq(parseDataPt('dentista na rua 7 de setembro terça')?.matched, 'terça', '§2 endereço não rouba a data');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 3. o handler real ──');
  {
    const casos = [
      // o relato
      ['marca Reunião com Pedro dia 18/11 as 8h', 'Reunião com Pedro'],
      ['Reunião com Pedro dia 18/11 as 8h', 'Reunião com Pedro'],
      ['marca santo antonio dia 29/11 as 8', 'Santo antonio'],
      ['marca Santo Antônio dia 29/11 às 8', 'Santo Antônio'],
      // a mesma família
      ['marca jantar no dia 29/11 às 20h', 'Jantar'],
      ['marca Reunião dia 18/11 com Pedro as 8h', 'Reunião com Pedro'],
      ['marca reunião na sexta com o Pedro às 10h', 'Reunião com o Pedro'],
      ['marca reunião às 15h com o Pedro amanhã', 'Reunião com o Pedro'],
      ['marca Festa da Ana dia 29 de novembro às 20h', 'Festa da Ana'],
      ['marca aniversário da Maria dia 5 de dezembro', 'Aniversário da Maria'],
      ['marca Entrega do TCC até sexta 18h', 'Entrega do TCC'],
      ['marca reunião sexta feira 10h', 'Reunião'],
      ['marca dentista terça que vem 15h', 'Dentista'],
      ['marca check-up com a Dra. Ana próxima segunda 9h', 'Check-up com a Dra. Ana'],
      ['marca Festa no dia 10 de dezembro de 2027', 'Festa'],
      ['Anota que tenho Prova de Cálculo dia 2/12', 'Prova de Cálculo'],
      // ⚠️ palavra inteira: "qua" (quarta) apagava o miolo de "quadra"
      ['marca futebol na quadra qua 20h', 'Futebol na quadra'],
      // ⚠️ o "da" que NÃO está colado na data fica
      ['marca Festa da Ana dia 29/11', 'Festa da Ana'],
      ['marca consulta na Unimed dia 20 às 14h', 'Consulta na Unimed'],
      // pontuação e grafia como a pessoa escreveu
      ['me lembra de ligar pro Dr. Carlos sexta às 10h', 'Ligar pro Dr. Carlos'],
      ['marca Dr.Aluísio Cardiologista, 25/12 às 10:00', 'Dr.Aluísio Cardiologista'],
      ['marca Aniversário 🎂 da Bia dia 3/12', 'Aniversário 🎂 da Bia'],
      ['MARCA REUNIÃO COM PEDRO DIA 18/12 AS 8H', 'REUNIÃO COM PEDRO'],
      ['marca iPhone na Apple Store dia 2/12', 'iPhone na Apple Store'],
      ['marca Dia das Mães 10/05', 'Dia das Mães'],
      // já funcionavam — não podem regredir
      ['marca dentista terça 15h', 'Dentista'],
      ['Marca dentista Terça 15h', 'Dentista'],
      ['tenho uma reunião com o João amanhã às 19, me lembra?', 'Reunião com o João'],
      ['agendar Call com a Microsoft amanhã 9h me avisa 1 dia antes', 'Call com a Microsoft'],
      ['me lembra de cancelar o hotel amanhã', 'Cancelar o hotel'],
      ['Me lembra: de cancelar o hotel amanhã', 'Cancelar o hotel'],
      ['marca reunião amanhã 9h', 'Reunião'],
      ['me lembra amanhã às 10h', 'Compromisso'],
    ];
    for (const [frase, titulo] of casos) {
      const c = await marcar(frase);
      ok(c, `§3 não marcou: "${frase}"`);
      if (c) eq(c.titulo, titulo, `§3 "${frase}"`);
    }
    // a data e a hora continuam as mesmas de antes
    const r = await marcar('marca Reunião com Pedro dia 18/11 as 8h');
    eq([r.data.slice(5), r.hora, r.lembrete_antecedencia], ['11-18', '08:00', 60], '§3 data/hora/aviso intactos');
    const j = await marcar('marca Viagem pra Gramado dia 5 de janeiro');
    eq([j.titulo, j.data], ['Viagem pra Gramado', proximaVez(0, 5)], '⚠️ §3 "dia 5 de janeiro" é janeiro');
    // a confirmação mostra o mesmo título que foi gravado
    await marcar('marca Reunião com Pedro dia 18/11 as 8h');
    ok(/\*Reunião com Pedro\*/.test(enviados[0] || ''), '§3 a confirmação mostra "Reunião com Pedro"');

    // ⚠️ CAMINHO DA IA: quando o parser local não reconhece a frase, a IA a
    // traduz num comando e o handler roda de novo. A grafia tem de vir da
    // PESSOA, não do que a IA devolveu (aqui a IA minusculizou tudo).
    const ia = await marcar('Dr.Aluísio Cardiologista, 25/12 às 10:00', 'marca dr aluísio cardiologista 25/12 10h');
    eq(ia?.titulo, 'Dr.Aluísio Cardiologista', '⚠️ §3 IA: a grafia vem da mensagem da pessoa');
    const ia2 = await marcar('Pilates com a Fernanda 2/12 18h', 'marca pilates com a fernanda 2/12 18h');
    eq(ia2?.titulo, 'Pilates com a Fernanda', '§3 IA: outra frase');
    // palavra que só a IA escreveu fica na grafia da IA
    const ia3 = await marcar('Yoga 2/12 7h', 'marca Aula de yoga 2/12 7h');
    eq(ia3?.titulo, 'Aula de Yoga', '§3 IA: palavra que a pessoa não escreveu fica como a IA mandou');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 4. ⚠️ nenhuma frase muda de rumo ──');
  {
    // CÓPIA CONGELADA do parseDataPt de antes do conserto (24/11/2026).
    const isoA = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
    function proxDia(alvo) { const h = new Date(); h.setHours(12, 0, 0, 0); const dl = (alvo - h.getDay() + 7) % 7; const d = new Date(h); d.setDate(d.getDate() + dl); return d; }
    function antigo(t) {
      const txt = ' ' + t.toLowerCase() + ' ';
      let m;
      if (/\bdepois de amanh[ãa](?=\W|$)/.test(txt)) { const d = new Date(); d.setDate(d.getDate() + 2); return { iso: isoA(d), matched: (txt.match(/depois de amanh[ãa]/) || [])[0] }; }
      if (/\bamanh[ãa](?=\W|$)/.test(txt)) { const d = new Date(); d.setDate(d.getDate() + 1); return { iso: isoA(d), matched: (txt.match(/amanh[ãa]/) || [])[0] }; }
      if (/\bhoje\b/.test(txt)) { return { iso: isoA(new Date()), matched: 'hoje' }; }
      if (m = txt.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)) {
        const dd = +m[1], mo = +m[2];
        const yy = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
        return { iso: isoA(new Date(yy, mo - 1, dd, 12)), matched: m[0] };
      }
      if (m = txt.match(/\bdia\s+(\d{1,2})\b/)) {
        const dd = +m[1], now = new Date();
        let d = new Date(now.getFullYear(), now.getMonth(), dd, 12);
        if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(now.getFullYear(), now.getMonth() + 1, dd, 12);
        return { iso: isoA(d), matched: m[0] };
      }
      const dias = ['domingo', 'segunda', 'ter[çc]a', 'quarta', 'quinta', 'sexta', 's[áa]bado'];
      const abbr = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
      for (let i = 0; i < 7; i++) {
        const mm = txt.match(new RegExp(`\\b(${dias[i]}(?:-feira)?|${abbr[i]})\\b`));
        if (mm) { let d = proxDia(i); if (/\b(que vem|que vem|pr[óo]xim[ao])\b/.test(txt) && isoA(d) === isoA(new Date())) d.setDate(d.getDate() + 7); return { iso: isoA(d), matched: mm[0] }; }
      }
      return null;
    }

    const MESES = ['janeiro', 'fevereiro', 'março', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const datas = ['amanhã', 'hoje', 'depois de amanhã', '29/11', '1/1/2027', 'terça', 'sexta-feira', 'sab', 'próxima quinta', 'quarta que vem',
      'dia 1', 'dia 15', 'dia 31', 'dia 7 de manhã', '25 de março', 'rua 7 de setembro', 'dia 31 de fevereiro', 'dia 29 de fevereiro', 'dia 30 de abril de 2028', ''];
    for (const mes of MESES) for (const dd of [1, 5, 15, 28, 31]) { datas.push(`dia ${dd} de ${mes}`); datas.push(`${dd} de ${mes}`); }
    const molduras = [(d) => `marca reunião ${d}`, (d) => `${d} dentista`, (d) => `me lembra de pagar o boleto ${d} às 10h`,
      (d) => `anota que a festa é ${d}`, (d) => `tenho que entregar até ${d}`, (d) => `${d}`.toUpperCase(), (d) => `Consulta ${d}, me avisa`];
    let total = 0, mudouRumo = 0, mudouSemMes = 0, comMes = 0;
    for (const d of datas) for (const f of molduras) {
      const frase = f(d); total++;
      const a = antigo(frase), n = parseDataPt(frase);
      if (!!a !== !!n) { mudouRumo++; falhas.push(`⚠️ §4 "${frase}" mudou de rumo (antes ${!!a}, agora ${!!n})`); }
      const temMes = /\bdia\s+\d{1,2}\s+de\s+(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i.test(frase);
      if (temMes) comMes++;
      else if (JSON.stringify(a) !== JSON.stringify(n)) { mudouSemMes++; falhas.push(`§4 "${frase}" mudou sem ter mês escrito: ${JSON.stringify(a)} → ${JSON.stringify(n)}`); }
    }
    ok(total > 900, `§4 bateria pequena demais (${total})`);
    ok(comMes > 300, `§4 poucos casos com mês (${comMes})`);
    console.log(`  ${total} frases · ${comMes} com mês escrito · rumo mudou em ${mudouRumo} · sem mês, resultado mudou em ${mudouSemMes}`);
  }

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ título do compromisso: grafia da pessoa, sem data no título, nenhuma frase mudou de rumo');
})().catch((e) => { console.error(e); process.exit(1); });
