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
  expect(t('pt', 'history.sent', { time: '14:32' })).toBe('enviada 14:32')
  expect(t('en', 'history.answerOther', { key: 'C', text: 'lavanda' })).toBe('Answer C (Other: "lavanda")')
  expect(t('pt', 'history.answerOther', { key: 'C', text: 'lavanda' })).toBe('Resposta C (Outra: "lavanda")')
  expect(t('en', 'history.answer', {})).toBe('Answer {key}')
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
