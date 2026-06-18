// =====================================================================
// FAQ da Sora — base de conhecimento local-first.
// O matcher (services/faq.js) testa os `gatilhos` (regex ASCII) contra a
// mensagem normalizada (sem acento, minúscula) e retorna a `resposta`.
// Cobre as perguntas mais comuns sem gastar IA; o que não casar cai na IA.
//
// Gatilhos: escreva em ASCII (sem acento). A mensagem é normalizada antes.
// Ordem importa: do mais específico pro mais genérico.
// =====================================================================

const SUP = '📧 contatosora.ai@gmail.com\n📱 WhatsApp (32) 99916-7475';
const PAINEL = 'https://forsora.com/dashboard';

const FAQ = [
  // ── SOBRE / COMO FUNCIONA ──────────────────────────────────────────
  {
    id: 'o-que-e',
    gatilhos: [/\bo que (voce|a sora|vc) faz\b/, /como (a sora|voce|vc) funciona/, /como funciona (a )?sora/, /\bo que e (a )?sora\b/, /pra que (voce|a sora|isso) serve/, /quem e voce/],
    resposta:
`Oi! Eu sou a *Sora* 🐳 — sua assistente financeira pessoal aqui no WhatsApp.

Você me conta seus gastos e receitas em linguagem normal (ex.: "gastei 50 no mercado") e eu *interpreto, categorizo e lanço* automaticamente. Você acompanha tudo organizado no painel: saldos, gráficos, metas, limites e relatórios.

Além das finanças, tenho o *Sora Grow* (hábitos, tarefas, agenda, saúde e mais).

Quer começar? Manda um gasto ou diz *ajuda* pra ver tudo que eu faço.`,
  },
  {
    id: 'registrar-gasto',
    gatilhos: [/como (eu )?(registr|lanc|anot|adicion|coloc)\w* (um )?(gasto|despesa|compra)/, /como (eu )?(registr|lanc|anot)\w* (uma )?(receita|recebimento)/, /como (eu )?(uso|começo|comeco|funciona) (os )?lancamentos/, /como (te )?conto (um|meus) gasto/],
    resposta:
`É só me mandar do jeito que você fala! 😄 Exemplos:

• "gastei 50 no mercado"
• "paguei 120 de luz pelo nubank"
• "recebi 3000 de salário"
• "comprei 200 em roupas no cartão do inter"

Eu entendo o valor, a categoria e a conta, e lanço na hora. Funciona por *texto*, *áudio*, *foto da nota* ou *PDF*. Não precisa de comando nenhum — fala natural. 💚`,
  },
  {
    id: 'audio',
    gatilhos: [/posso (mandar|enviar) (um )?audio/, /\bda(\s|-)?pra (mandar|enviar|usar) audio/, /aceita audio/, /(entende|reconhece) audio/],
    resposta:
`Pode sim! 🎙️ Manda um *áudio* falando o gasto (ex.: "gastei sessenta reais no posto") que eu transcrevo e lanço automaticamente.

Ótimo pra quando você tá na correria e não quer digitar. Funciona igual ao texto.`,
  },
  {
    id: 'foto-comida-macros',
    gatilhos: [/foto.{0,12}(comida|prato|refei)/, /(macro|caloria|kcal).{0,18}(foto|imagem)/, /(foto|imagem).{0,18}(macro|caloria|kcal|comida|prato)/, /como.{0,18}(saber|ver|calcul\w*|descobr\w*).{0,18}(macro|caloria|kcal)/, /quantas calorias.{0,18}(tem|isso|foto|prato)/],
    resposta:
`Manda a *foto da comida* aqui com a legenda *macros* (ou "calorias") 📸🍽️

Eu analiso o prato, identifico os alimentos e te devolvo os *macros estimados*: calorias, proteínas, carboidratos e gorduras.

É uma estimativa pela imagem (valores aproximados). Disponível nos planos *Premium* e *Black*.`,
  },
  {
    id: 'foto-pdf-ocr',
    gatilhos: [/foto da nota/, /(mandar|enviar|tirar) foto/, /\bnota fiscal\b/, /\bcupom\b/, /\bocr\b/, /\bpdf\b/, /(foto|imagem) (do|de) comprovante/, /comprovante/],
    resposta:
`Sim! 📸 Você pode:

• Mandar a *foto da nota fiscal / cupom* — eu leio o valor e lanço (OCR).
• Mandar um *PDF* (fatura, extrato) — eu interpreto.

A leitura por *imagem (OCR)* e *PDF* faz parte dos planos *Premium* e *Black*. No Básico, você lança por texto e áudio. 😉`,
  },
  {
    id: 'conta-padrao',
    gatilhos: [/de qual conta (saiu|veio)/, /como (voce|vc) sabe (a|de qual|qual) conta/, /conta padrao/, /(nao|sem) (falar|dizer|mencionar) (o|a) (banco|conta)/],
    resposta:
`Se você não disser o banco, eu uso a sua *conta padrão* (você define qual é uma vez). 🏦

Se você ainda não escolheu uma e tiver várias contas, eu *pergunto* de qual saiu — é só responder o nome ou o número da opção.

E você sempre pode especificar: "gastei 50 no mercado *pelo nubank*". Pra corrigir o último, diga: "*na verdade foi no inter*".`,
  },

  // ── CONTA / WHATSAPP ───────────────────────────────────────────────
  {
    id: 'vincular-whatsapp',
    gatilhos: [/como (eu )?vinculo (o|meu)? ?whatsapp/, /vincular (o )?numero/, /conectar (o )?whatsapp/, /como (ligo|conecto) (meu )?numero/],
    resposta:
`Você vincula o WhatsApp na hora do cadastro, ou depois em *forsora.com → Configurações → WhatsApp*. 📱

É o número vinculado que conversa comigo aqui. Se precisar trocar, é no mesmo lugar (botão *Reconfigurar*).`,
  },
  {
    id: 'trocar-numero',
    gatilhos: [/mudei (de )?numero/, /troquei (de )?numero/, /trocar (de )?(numero|whatsapp|chip)/, /novo numero/, /mudar (o )?whatsapp/],
    resposta:
`Tranquilo! Entre em *forsora.com → Configurações → WhatsApp → Reconfigurar* e cadastre o número novo. ✅

⚠️ Cada número fica vinculado a *uma* conta só. Se der erro de "número já em uso", me chama no suporte:
${SUP}`,
  },
  {
    id: 'privacidade-numero',
    gatilhos: [/(esse|este) numero e (so )?meu/, /outras pessoas (veem|vem|tem acesso)/, /(alguem|outros) (ve|veem|acessa) meus dados/, /meus dados (sao|são) privados/, /quem ve meus dados/],
    resposta:
`Seus dados são *privados e individuais* 🔒. Cada conta é sua — ninguém vê seus lançamentos.

A *única* exceção é se você criar/entrar num *grupo* (gestão compartilhada, no Premium): aí você escolhe o que compartilhar com cônjuge/família. Fora isso, é tudo só seu.`,
  },

  // ── PLANOS / PAGAMENTO ─────────────────────────────────────────────
  {
    id: 'precos-planos',
    gatilhos: [/quanto custa/, /qual.{0,10}(preco|valor)/, /\bpreco\b/, /quais (os|sao os)? ?planos/, /\bplanos?\b.{0,15}(valor|preco|quanto)/, /\bmensalidade\b/, /quanto (e|fica|sai)/],
    resposta:
`Temos 3 planos (sem fidelidade, cancela quando quiser):

• *Básico — R$ 19,90/mês*: lançamentos ilimitados, 3 contas, relatórios, limites e o Sora Grow básico.
• *Premium — R$ 29,90/mês*: contas ilimitadas, OCR (foto), OFX, investimentos, gestão compartilhada e o Sora Grow completo.
• *Black — R$ 79,90/mês*: tudo do Premium + a área *Negócios* (DRE, integrações Hotmart/Stripe).

No *anual* tem desconto. Veja e assine em 👉 forsora.com/planos`,
  },
  {
    id: 'diferenca-planos',
    gatilhos: [/diferenca.{0,12}plano/, /\bbasico\b.{0,10}(premium|black)/, /premium.{0,10}black/, /qual (plano|o melhor)/, /o que (cada|muda) (no )?plano/, /o que (vem|tem).{0,12}(no|em cada) plano/],
    resposta:
`Resumo rápido:

• *Básico (R$19,90)* — o essencial: lançar gastos/receitas, 3 contas, gráficos, limites, metas e o Grow básico (hábitos, tarefas, agenda, bem-estar).
• *Premium (R$29,90)* — pra organizar tudo: contas/cartões *ilimitados*, foto de nota (OCR), importar OFX, *investimentos*, compartilhar com a família e o *Grow completo* (saúde, estudos, casa, viagens, filmes, leituras).
• *Black (R$79,90)* — pra quem empreende: tudo do Premium + *Negócios* (DRE, forecast, integrações de vendas).

Compare em 👉 forsora.com/planos`,
  },
  {
    id: 'como-assinar',
    gatilhos: [/como (eu )?(assino|assinar|contrato|contratar|pago|pagar)/, /como (faco|faço) (pra|para) assinar/, /quero assinar/, /como (dou|fazer|faco|faço) (o )?upgrade/, /como mud(o|ar) (de )?plano/],
    resposta:
`Pelo painel, em 1 minutinho: 👉 forsora.com/planos

Escolhe o plano, clica em assinar e paga com segurança pelo *Stripe* (cartão). O acesso libera na hora. Pra trocar de plano depois (upgrade/downgrade), é no mesmo lugar. 💳`,
  },
  {
    id: 'teste-gratis',
    gatilhos: [/teste (gratis|gratuito|gratuita)/, /\btrial\b/, /\bgratis\b/, /(periodo|dias) (de )?(teste|experiencia)/, /posso (testar|experimentar)/, /tem (como )?testar/],
    resposta:
`Você pode *ver a Sora funcionando de graça* na demo ao vivo do site (👉 forsora.com) antes de assinar.

Pra usar comigo no WhatsApp de verdade — lançar gastos, ver saldo, metas — é com um plano ativo (a partir de *R$ 19,90/mês*, sem fidelidade). Cancela quando quiser. 😉`,
  },
  {
    id: 'cancelar',
    gatilhos: [/como (eu )?cancelo/, /cancelar (o |a |meu |minha )?(plano|assinatura|conta)/, /quero cancelar/, /como (faco|faço) (pra )?cancelar/, /encerrar (plano|assinatura)/, /nao quero mais (pagar|assinar)/],
    resposta:
`Que pena! 😢 Mas você mesmo cancela em menos de 1 minuto:

1️⃣ Acesse *forsora.com* e entre na conta
2️⃣ *Configurações → Plano e Cobrança*
3️⃣ Toque em *Gerenciar assinatura* (abre o portal seguro da Stripe)
4️⃣ *Cancelar plano* e confirmar

Você continua com acesso até o fim do período já pago e não recebe mais cobrança. Qualquer dúvida: 📧 contatosora.ai@gmail.com`,
  },
  {
    id: 'anual-desconto',
    gatilhos: [/plano anual/, /pagar (no )?anual/, /desconto.{0,10}anual/, /anual.{0,10}desconto/, /\banual\b/, /sai mais barato/],
    resposta:
`Tem sim! 🎉 No *plano anual* você paga adiantado e economiza bastante (chega a *-40%* no mês). É só escolher *Anual* na hora de assinar:

👉 forsora.com/planos`,
  },
  {
    id: 'trocar-cartao',
    gatilhos: [/troc(ar|o) (o )?cartao/, /atualizar (o )?(cartao|pagamento|cobranca)/, /mudar (a )?forma de pagamento/, /cartao (da )?cobranca/, /alterar pagamento/],
    resposta:
`Você atualiza o cartão pelo portal de cobrança:

*forsora.com → Configurações → Plano e Cobrança → Gerenciar assinatura* (abre a Stripe).

Lá você troca o cartão, vê faturas e gerencia tudo com segurança. 💳`,
  },

  // ── PAINEL ─────────────────────────────────────────────────────────
  {
    id: 'acessar-painel',
    gatilhos: [/como (eu )?acesso.{0,8}painel/, /onde (fica|acesso|vejo).{0,8}painel/, /link (do|pro) painel/, /(qual|cade) (o )?painel/, /como acessar.{0,8}(painel|site|dashboard)/],
    resposta:
`Seu painel fica aqui 👉 ${PAINEL}

É só entrar com seu e-mail e senha. Lá você vê gráficos, saldos, metas, relatórios e configura tudo. (Você também pode só me mandar *painel* aqui que eu te mando o link.)`,
  },
  {
    id: 'painel-vs-whatsapp',
    gatilhos: [/o que.{0,18}(no |pelo )painel/, /o que.{0,12}fazer.{0,12}painel/, /painel.{0,15}whatsapp/, /diferenca (do )?painel/, /pra que (serve|usar) (o )?painel/, /so pelo whatsapp/],
    resposta:
`Os dois se completam! 🤝

*Pelo WhatsApp* (comigo): lançar gastos, ver saldo/resumo, marcar hábitos, criar lembretes — o dia a dia, rapidinho.

*No painel* (forsora.com): a visão completa — gráficos interativos, relatórios, configurar contas/cartões/metas/limites, investimentos, importar extratos e gerenciar o plano.

Tudo sincroniza entre os dois. 💚`,
  },

  // ── FINANÇAS ───────────────────────────────────────────────────────
  {
    id: 'criar-conta-cartao',
    gatilhos: [/como (eu )?(crio|criar|cadastr|adicion|coloc)\w*.{0,10}(conta|carteira|cartao)/, /como (adiciono|cadastro|coloco).{0,12}(banco|conta|cartao)/],
    resposta:
`Você cria suas contas e cartões no *painel* (forsora.com → *Contas*) ou aqui comigo:

• "criar conta Nubank"
• "criar cartão Inter limite 5000 fecha dia 3"

Aí toda vez que você lançar um gasto, eu já desconto da conta certa e mostro saldos e faturas atualizados. 🏦`,
  },
  {
    id: 'ver-saldo',
    gatilhos: [/(ver|qual|meu|consultar) saldo/, /quanto (eu )?tenho/, /\bsaldos?\b/, /(meu )?resumo (do mes|financeiro)/, /quanto (gastei|sobrou)/],
    resposta:
`Fácil! Aqui no WhatsApp:

• *saldo* → mostro o saldo das suas contas
• *resumo* → o resumo do mês (gastos, receitas, saldo e top categorias)

E no painel (forsora.com) você vê tudo em gráficos, mês a mês. 📊`,
  },
  {
    id: 'cartao-fatura',
    gatilhos: [/(controle|controlar|como funciona).{0,15}cartao/, /(cartao de credito).{0,15}(funciona|fatura)/, /(quando|como).{0,18}fatura.{0,12}(fecha|vence|funciona)/, /como funciona.{0,12}fatura/],
    resposta:
`Eu cuido do seu cartão de crédito de ponta a ponta 💳:

• Lança a compra no cartão ("comprei 200 no cartão do nubank") e na parcelada ("em 3x de 100").
• Acompanha a *fatura em aberto*, data de *fechamento* e *vencimento*.
• No fechamento/vencimento eu *te aviso* e até ofereço pagar debitando de uma conta.

Configura limite e datas no painel ou por aqui ("cartão nubank fecha dia 3 vence dia 10").`,
  },
  {
    id: 'dividas-parcelas',
    gatilhos: [/como (cadastr|registr|anot|funciona|coloc|cri|control)\w*.{0,14}(divida|parcela|financiament|emprestim|crediario)/, /o que (e|sao).{0,14}(divida|parcela|crediario)/, /como (funciona|uso).{0,14}(divida|parcela)/],
    resposta:
`Manda que eu organizo! 📉

• *Dívidas* ("cadastrar dívida empréstimo 5000 em 10x vence dia 5"): eu calculo juros, agendo *lembretes mensais* e mostro a projeção de quitação.
• *Compras parceladas* ("comprei 900 em 3x no cartão"): eu distribuo as parcelas nos meses certos.

Você acompanha tudo no painel, em *Dívidas*.`,
  },
  {
    id: 'metas-limites',
    gatilhos: [/como (defin|cri|coloc|funciona|uso)\w*.{0,10}meta/, /como (defin|cri|coloc|funciona|uso)\w*.{0,10}limite/, /o que (e|sao).{0,10}(meta|limite)/, /quanto posso gastar/, /alerta de (gasto|limite)/],
    resposta:
`Dá pra se planejar de duas formas:

• *Metas*: "minha meta é juntar 5000 até dezembro" — eu calculo quanto poupar por mês (no Premium, com aporte automático).
• *Limites por categoria*: "limite de 800 no mercado" — quando você se aproxima, eu *te aviso* antes de estourar. 🚨

Configura também no painel (*Metas* e *Limites*).`,
  },
  {
    id: 'investimentos',
    gatilhos: [/como (funciona|ver|acompanh|cri|registr|uso)\w*.{0,12}investiment/, /o que (e|tem|sao).{0,12}investiment/, /(tenho|posso|como).{0,12}(investiment|cripto|acoes|fiis|renda fixa)/, /minha carteira de investiment/],
    resposta:
`A *Central de Investimentos* (planos *Premium* e *Black*) acompanha cripto, ações, FIIs e renda fixa 📈:

• Rentabilidade atualizada
• Cálculo automático de quanto aportar pra bater suas metas
• Recomendações por perfil de risco

Você gerencia no painel, em *Investimentos*.`,
  },
  {
    id: 'importar-ofx',
    gatilhos: [/importar (extrato|ofx|csv)/, /\bofx\b/, /extrato do banco/, /open finance/, /conectar (o )?banco/, /sincronizar (com o )?banco/],
    resposta:
`Sim! 📥 No painel (planos *Premium*/*Black*) você importa o *extrato OFX* do seu banco — eu mostro um preview pra você revisar antes de lançar tudo de uma vez.

A importação é feita pelo *painel web* (forsora.com), que dá pra conferir cada transação com calma.`,
  },
  {
    id: 'compartilhar-familia',
    gatilhos: [/compartilh/, /com (meu|minha) (esposa|marido|conjuge|namorad|familia|parceir)/, /(conta|gestao) (compartilhada|conjunta|do casal)/, /usar (junto|em dois)/, /\bgrupo\b/],
    resposta:
`Dá pra gerenciar as finanças *em conjunto* (gestão compartilhada — plano *Premium*) 👨‍👩‍👧:

Você cria um grupo e convida o cônjuge/família. Vocês compartilham contas, metas e relatórios. No *Sora Grow* você escolhe o que é compartilhado e o que fica privado de cada um.

Configura no painel, em *Grupos*.`,
  },

  // ── SORA GROW ──────────────────────────────────────────────────────
  {
    id: 'o-que-e-grow',
    gatilhos: [/\bsora grow\b/, /\bo que e (o )?grow\b/, /pra que (serve )?(o )?grow/, /como funciona (o )?grow/],
    resposta:
`O *Sora Grow* é a sua vida além das finanças 🌱 — tudo organizado no mesmo lugar:

• *Base (todos os planos)*: hábitos, tarefas, agenda e bem-estar.
• *Completo (Premium/Black)*: saúde (treinos, remédios, consultas), estudos, casa (compras, despensa, receitas) e coleções (viagens, filmes, leituras).

E você comanda muita coisa por aqui mesmo: "fiz academia", "me lembra de X amanhã"…`,
  },
  {
    id: 'habito',
    gatilhos: [/como (cri|marc|adicion|funciona|uso|registr)\w*.{0,10}habito/, /o que (e|sao).{0,8}habito/, /\bstreak\b/, /como funciona.{0,10}habito/],
    resposta:
`No *Grow → Hábitos* você cria seus hábitos (ou por aqui). Pra marcar como feito, é só mandar:

• "fiz academia"
• "fiz todos" (marca todos os de hoje)

Eu atualizo seu *streak* (sequência) e as conquistas. Ative o lembrete diário na aba Hábitos que eu te cutuco no horário. 🔥`,
  },
  {
    id: 'lembrete-agenda',
    gatilhos: [/me lembr/, /como (marc|cri|agend|fa[cz])\w*.{0,14}(compromisso|lembrete|agenda)/, /como (te )?(peco|pedir|peço).{0,18}(lembr|compromisso)/, /como (funciona|uso).{0,10}(agenda|lembrete)/, /\bme avisa\b.{0,15}(amanha|hoje|dia|hora|antes)/],
    resposta:
`Só me pedir naturalmente! 🗓️

• "*me lembra que amanhã tenho que* enviar o relatório"
• "*marca dentista terça 15h me avisa 1 dia antes*"
• "Sora, *tenho reunião dia 12 às 18, me lembra?*"

Eu crio na sua agenda e te lembro. Com horário, aviso *antes* da hora; sem horário, o item aparece no seu dia. Pra ver tudo: *minha agenda*.`,
  },

  // ── RESUMOS / SEGURANÇA / SUPORTE ──────────────────────────────────
  {
    id: 'resumos',
    gatilhos: [/\bresumos?\b.{0,15}(manda|envia|recebo|automatico|semanal|mensal)/, /(ativar|desativar|ligar|desligar|parar).{0,10}resumo/, /(voce|vc) (me )?(manda|envia) resumo/, /resumo (semanal|mensal|automatico)/],
    resposta:
`Mando sim! 📊 Todo *domingo de manhã* eu te envio o resumo da sua semana, e no *dia 1º* o fechamento do mês anterior — com seus números e uma leitura do que mudou.

Pra controlar: diga *ativar resumos* ou *desativar resumos*, ou ajuste em *Configurações → WhatsApp* no painel.`,
  },
  {
    id: 'seguranca',
    gatilhos: [/meus dados (estao|estão|sao|são) (seguro|protegido|salvo)/, /\bseguranca\b/, /\bseguro/, /(voces )?(vendem|compartilham) (meus )?dados/, /privacidade/, /confiavel/],
    resposta:
`Pode ficar tranquilo 🔒. Seus dados ficam guardados com segurança (infra do Supabase, criptografia em trânsito) e são *privados* — só você acessa. A gente *não vende nem compartilha* seus dados.

O pagamento é processado pela *Stripe* (líder mundial) — a Sora nem guarda o número do seu cartão. Dúvidas de privacidade? ${SUP}`,
  },
  {
    id: 'suporte-bug',
    gatilhos: [/\bsuporte\b/, /\bbug\b/, /(deu|tem|achei|encontrei) (um )?(erro|problema|falha)/, /nao (funciona|esta funcionando|ta funcionando)/, /falar com (alguem|humano|atendente|uma pessoa)/, /reclamacao/, /preciso de ajuda/],
    resposta:
`Tô aqui pra ajudar 💚. Se algo deu errado, achou um bug ou precisa falar com a gente, chama o suporte humano:

${SUP}

Você também pode relatar o problema (com print) no painel, em *Relatar um problema*. A gente responde rapidinho!`,
  },
];

module.exports = { FAQ };
