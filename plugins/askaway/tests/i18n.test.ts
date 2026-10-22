import { expect, test } from 'claude-code/testing'
import * as i18nModule from '../hooks/i18n'
import { MESSAGES, detectLang, plural, resolveLang, t } from '../hooks/i18n'

const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '')

test('both dictionaries have exactly the same keys', () => {
  const en = Object.keys(MESSAGES.en).sort()
  const pt = Object.keys(MESSAGES.pt).sort()
  expect(pt).toEqual(en)
})

// The distinct {name} placeholders of a message, sorted.
const namesOf = (text: string): string[] => [...new Set(placeholdersOf(text))].sort()

// The keys whose placeholder names differ between the two dictionaries. A name present in only one of the two is a mismatch.
function placeholderMismatches(en: Readonly<Record<string, string>>, pt: Readonly<Record<string, string>>): string[] {
  const keys = new Set([...Object.keys(en), ...Object.keys(pt)])
  return [...keys].filter(key => JSON.stringify(namesOf(en[key] ?? '')) !== JSON.stringify(namesOf(pt[key] ?? '')))
}

test('every key has the same {name} placeholders in its English and pt-BR messages, checked both ways', () => {
  expect(placeholderMismatches(MESSAGES.en, MESSAGES.pt)).toEqual([])
})

test('the placeholder check flags a name only the pt-BR message has, and a name only the English message has', () => {
  expect(placeholderMismatches({ hi: 'Hi {name}' }, { hi: 'Oi {name} {extra}' })).toEqual(['hi'])
  expect(placeholderMismatches({ hi: 'Hi {name} {extra}' }, { hi: 'Oi {name}' })).toEqual(['hi'])
  expect(placeholderMismatches({ hi: 'Hi {name}' }, { hi: 'Oi {name}' })).toEqual([])
})

test('the field button reads Apply in English and Aplicar in pt-BR, the word for choosing the typed text (M29b)', () => {
  expect(t('en', 'input.send')).toBe('Apply')
  expect(t('pt', 'input.send')).toBe('Aplicar')
})

test('the fit hint explains the 0 to 100 scale in both languages, in one line of at most 60 columns (M45)', () => {
  expect(t('en', 'option.fitHint')).toBe("fit N: the agent's estimate of fit, 0 to 100")
  expect(t('pt', 'option.fitHint')).toBe('aderência N: estimativa do agente, de 0 a 100')
  for (const lang of ['en', 'pt'] as const) expect([...t(lang, 'option.fitHint')].length).toBeLessThanOrEqual(60)
})

test('no pt-BR command reply keeps the English word "Use" as its verb (Gauntlet 5 B2 M8)', () => {
  const kept = Object.entries(MESSAGES.pt)
    .filter(([key, text]) => key.startsWith('command.') && /^Use\b/.test(text))
    .map(([key]) => key)
  expect(kept).toEqual([])
})

test('no message is left empty in either language', () => {
  const empty = [...Object.entries(MESSAGES.en), ...Object.entries(MESSAGES.pt)].filter(([, text]) => text.trim() === '')
  expect(empty).toEqual([])
})

test('the language comes from the first set locale variable, and pt-BR means pt', () => {
  expect(detectLang({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('pt')
  expect(detectLang({ LC_ALL: 'en_US.UTF-8', LANG: 'pt_BR.UTF-8' })).toBe('en')
  expect(detectLang({ LC_ALL: '', LC_MESSAGES: 'pt_BR', LANG: 'en_US' })).toBe('pt')
  expect(detectLang({ LANGUAGE: 'pt_BR:en' })).toBe('pt')
  expect(detectLang({ LANG: 'C.UTF-8' })).toBe('en')
})

test('with no locale variable at all, the language is English', () => {
  expect(detectLang({})).toBe('en')
  expect(detectLang({ LC_ALL: '   ', LANG: '' })).toBe('en')
})

test('a stored language wins; anything else falls back to the detected one', () => {
  expect(resolveLang('pt', 'en')).toBe('pt')
  expect(resolveLang('en', 'pt')).toBe('en')
  expect(resolveLang('auto', 'pt')).toBe('pt')
  expect(resolveLang(undefined, 'en')).toBe('en')
  expect(resolveLang('fr', 'pt')).toBe('pt')
  expect(resolveLang(null, 'en')).toBe('en')
})

test('t fills the named placeholders and keeps a placeholder with no value', () => {
  expect(t('en', 'history.sent', { time: '14:32' })).toBe('sent 14:32')
  expect(t('en', 'history.sent')).toBe('sent {time}')
  expect(t('pt', 'history.sent', { time: '14:32' })).toBe('enviada 14:32')
  expect(t('en', 'footer.last', { title: 'Pick', label: 'Keep', age: '1 min ago' })).toBe('last: Pick → Keep, 1 min ago')
  expect(t('pt', 'footer.last', { title: 'Escolha', label: 'Keep', age: 'há 1 min' })).toBe('última: Escolha → Keep, há 1 min')
})

test('the en toast.clearedPending text ends with a period, as the other en toasts do', () => {
  expect(t('en', 'toast.clearedPending', { n: 2 })).toBe('Cleared 2; waiting replies still reach their sessions.')
})

test('t reads a numeric value as its text', () => {
  expect(t('en', 'review.submit', { n: 3 })).toBe('Submit all (3)')
  expect(t('pt', 'review.submit', { n: 3 })).toBe('Enviar tudo (3)')
  expect(t('en', 'tree.submit')).toBe('Submit Answer')
  expect(t('pt', 'tree.submit')).toBe('Enviar resposta')
})

test('plural picks the one form for exactly 1 and the many form otherwise, in both languages', () => {
  expect(plural('en', 1, 'count.question.one', 'count.question.many')).toBe('1 question')
  expect(plural('en', 2, 'count.question.one', 'count.question.many')).toBe('2 questions')
  expect(plural('pt', 1, 'count.question.one', 'count.question.many')).toBe('1 pergunta')
  expect(plural('pt', 0, 'count.question.one', 'count.question.many')).toBe('0 perguntas')
})

test('the pt-BR reply to the language command names the language with its placeholder filled', () => {
  expect(t('pt', 'command.langSet', { lang: 'Português' })).toBe('O idioma do Askaway agora é Português.')
  expect(t('en', 'command.langSet', { lang: 'English' })).toBe('Askaway language is now English.')
})

// gauntlet 4, package B2
test('gauntlet 4, B2 M33: the three keys M33 removed are absent from both dictionaries, and i18n exports no langName', () => {
  for (const key of ['card.answeredElsewhere', 'command.describeLang', 'command.describeAway']) {
    expect(Object.keys(MESSAGES.en)).not.toContain(key)
    expect(Object.keys(MESSAGES.pt)).not.toContain(key)
  }
  expect('langName' in i18nModule).toBe(false)
})
