-- =============================================================================
-- 161 — coluna `plataforma` em users: de que dispositivo a pessoa normalmente
-- acessa o painel. Pedido do dono: "não sei quem é usuário Android e quem é
-- Apple, dá pra diferenciar no admin?".
--
-- Valores: 'android_app' (Play Store/TWA) · 'android_web' (navegador Android,
-- sem o app) · 'ios_pwa' (iPhone/iPad com "Adicionar à Tela de Início") ·
-- 'ios_web' (Safari/Chrome no iOS, sem instalar) · 'desktop' · 'outro'.
--
-- ⚠️ DETECTADO NO CLIENTE (User-Agent + o mesmo sinal de TWA que
-- `lib/origem-app.ts` já usa pro gate do Play Billing) e gravado por
-- `POST /api/user/dispositivo`, chamado UMA VEZ POR NAVEGADOR (guard em
-- localStorage — ver `components/app/DispositivoSync.tsx`).
--
-- ⚠️ É O RETRATO DA ÚLTIMA SESSÃO QUE GRAVOU, não um histórico nem uma
-- classificação definitiva do usuário: alguém que usa o app no celular e o
-- painel no notebook aparece como o dispositivo que enviou por último em CADA
-- navegador — o notebook manda a sua própria vez, o celular a dele. Serve pra
-- enxergar a DISTRIBUIÇÃO da base (quantos Android × iOS), não pra decisão
-- individual por usuário.
-- =============================================================================

alter table public.users add column if not exists plataforma text;

comment on column public.users.plataforma is
  'android_app | android_web | ios_pwa | ios_web | desktop | outro — detectado no cliente (lib/plataforma.ts), gravado 1x por navegador via POST /api/user/dispositivo. É a última sessão que gravou, não histórico.';
