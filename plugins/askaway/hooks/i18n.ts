// The two languages the mod speaks and the text of every drawn or replied string. The pt-BR dictionary is typed against
// the en keys, so a missing or extra key fails the compile; a test checks the placeholders too. Text the agent reads
// (deliveryLine in model.ts) is English and never goes through here.

export type Lang = 'en' | 'pt'

// The language the environment asks for: the first of LC_ALL, LC_MESSAGES, LANG, LANGUAGE that is set, pt when it starts with pt.
export type LangEnv = { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string; LANGUAGE?: string }
const LOCALE_VARS = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'] as const

// `{name}` marks a value that t() fills in.
const EN = {
  'pane.heading': 'Questions waiting',
  'counter.none': 'Nothing pending',
  'counter.pending.one': '{n} pending',
  'counter.pending.many': '{n} pending',
  'counter.line': '{pending} · {groups}',
  'count.question.one': '{n} question',
  'count.question.many': '{n} questions',
  'count.group.one': '{n} group',
  'count.group.many': '{n} groups',
  'risk.low': '✅ low risk',
  'risk.medium': '⚠️ medium risk',
  'risk.high': '🛑 high risk',
  'risk.other': '⚠️ {risk} risk',
  'age.now': 'now',
  'age.minutes': '{n} min ago',
  'age.hours': '{n} h ago',
  'age.days': '{n} d ago',
  'status.target.session': 'the session',
  'status.pending': '⏳ Answer {key} sent to {target}',
  'status.delivered': '✅ Answer {key} delivered to {target} (read by the session)',
  'status.sessionEnded': '⚠️ {target} ended before reading answer {key}',
  'status.expired': '⚠️ Answer {key} expired unread',
  'status.dismiss': 'Dismiss this line',
  'section.context': '🧭 Context and origin',
  'section.analogy': '🔁 Analogy',
  'section.why': '💡 Why {key}',
  'section.how': '🛠️ How',
  'section.gains': '🎁 What we gain',
  'section.losses': '⚖️ What we lose',
  'section.urgency': '⏱️ Urgency',
  'section.undo': '↩️ Undo',
  'option.recommended': 'Recommended',
  'option.other': 'Other…',
  'input.label': 'Your answer',
  'input.placeholder': 'Type your answer',
  'input.send': 'Done',
  'nav.back': '← Back',
  'nav.next': 'Next →',
  'card.answeredElsewhere': 'Answered elsewhere',
  'review.submit': 'Submit all ({n})',
  'band.open': 'Answer',
  'band.text': '{questions} waiting · {groups}',
  'toast.newQuestion': 'New question: {title}',
  'toast.undelivered': 'Answer {key} for {id} was not delivered; answer again in the session.',
  'command.describeOpen': 'Open the Askaway pane with the pending questions',
  'command.describeLang': 'Set the language: /askaway lang pt|en|auto',
  'command.describeAway': 'Toggle away mode: questions go to the Askaway inbox',
  'command.opened': 'Askaway pane opened.',
  'command.awayOn': 'Askaway away mode is on.',
  'command.awayOff': 'Askaway away mode is off.',
  'command.awayUnavailable': 'Askaway away mode is unavailable: no state folder (HOME is unset).',
  'command.langSet': 'Askaway language is now {lang}.',
  'command.langInvalid': 'Use /askaway lang pt, en or auto.',
  'list.head.one': 'Askaway: 1 open',
  'list.head.many': 'Askaway: {n} open',
  'list.awayOn': ', away mode on',
  'list.row': 'open · {id} · {title} (recommended {rec})',
} as const

export type MessageKey = keyof typeof EN

const PT: Record<MessageKey, string> = {
  'pane.heading': 'Perguntas aguardando',
  'counter.none': 'Nenhuma pendente',
  'counter.pending.one': '{n} pendente',
  'counter.pending.many': '{n} pendentes',
  'counter.line': '{pending} · {groups}',
  'count.question.one': '{n} pergunta',
  'count.question.many': '{n} perguntas',
  'count.group.one': '{n} grupo',
  'count.group.many': '{n} grupos',
  'risk.low': '✅ risco baixo',
  'risk.medium': '⚠️ risco médio',
  'risk.high': '🛑 risco alto',
  'risk.other': '⚠️ risco {risk}',
  'age.now': 'agora',
  'age.minutes': 'há {n} min',
  'age.hours': 'há {n} h',
  'age.days': 'há {n} d',
  'status.target.session': 'a sessão',
  'status.pending': '⏳ Resposta {key} enviada para {target}',
  'status.delivered': '✅ Resposta {key} entregue para {target} (lida pela sessão)',
  'status.sessionEnded': '⚠️ {target} encerrou antes de ler a resposta {key}',
  'status.expired': '⚠️ Resposta {key} expirou sem ser lida',
  'status.dismiss': 'Dispensar esta linha',
  'section.context': '🧭 Contexto e origem',
  'section.analogy': '🔁 Analogia',
  'section.why': '💡 Por que {key}',
  'section.how': '🛠️ Como',
  'section.gains': '🎁 O que ganhamos',
  'section.losses': '⚖️ O que perdemos',
  'section.urgency': '⏱️ Urgência',
  'section.undo': '↩️ Como desfazer',
  'option.recommended': 'Recomendada',
  'option.other': 'Outra…',
  'input.label': 'Sua resposta',
  'input.placeholder': 'Digite sua resposta',
  'input.send': 'Pronto',
  'nav.back': '← Voltar',
  'nav.next': 'Próxima →',
  'card.answeredElsewhere': 'Respondida em outro lugar',
  'review.submit': 'Enviar tudo ({n})',
  'band.open': 'Responder',
  'band.text': '{questions} aguardando · {groups}',
  'toast.newQuestion': 'Nova pergunta: {title}',
  'toast.undelivered': 'A resposta {key} de {id} não foi entregue; responda de novo na sessão.',
  'command.describeOpen': 'Abre o painel do Askaway com as perguntas pendentes',
  'command.describeLang': 'Define o idioma: /askaway lang pt|en|auto',
  'command.describeAway': 'Liga ou desliga o modo ausente: as perguntas vão para a caixa do Askaway',
  'command.opened': 'Painel do Askaway aberto.',
  'command.awayOn': 'Modo ausente do Askaway ligado.',
  'command.awayOff': 'Modo ausente do Askaway desligado.',
  'command.awayUnavailable': 'O modo ausente não está disponível: sem pasta de estado (HOME não definido).',
  'command.langSet': 'O idioma do Askaway agora é {lang}.',
  'command.langInvalid': 'Use /askaway lang pt, en ou auto.',
  'list.head.one': 'Askaway: 1 pendente',
  'list.head.many': 'Askaway: {n} pendentes',
  'list.awayOn': ', modo ausente ligado',
  'list.row': 'pendente · {id} · {title} (recomendada {rec})',
}

export const MESSAGES: Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> = { en: EN, pt: PT }

const isLang = (value: unknown): value is Lang => value === 'en' || value === 'pt'

export function detectLang(env: LangEnv): Lang {
  const locale = LOCALE_VARS.map(name => env[name]).find(value => value !== undefined && value.trim() !== '')
  return locale?.trim().toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

// A language stored by the user wins; anything else (missing, 'auto', a typo) falls back to the detected one.
export function resolveLang(stored: unknown, detected: Lang): Lang {
  return isLang(stored) ? stored : detected
}

export function t(lang: Lang, key: MessageKey, vars: Readonly<Record<string, string | number>> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  )
}

// The count form of a message: `one` for exactly 1, `many` otherwise. Both take the count as {n}.
export function plural(lang: Lang, n: number, one: MessageKey, many: MessageKey): string {
  return t(lang, n === 1 ? one : many, { n })
}
