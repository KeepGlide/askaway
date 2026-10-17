import { expect, test } from 'claude-code/testing'
import { MESSAGES, detectLang, plural, resolveLang, t, type MessageKey } from '../hooks/i18n'

const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '')

test('both dictionaries have exactly the same keys', () => {
  const en = Object.keys(MESSAGES.en).sort()
  const pt = Object.keys(MESSAGES.pt).sort()
  expect(pt).toEqual(en)
})

test('every {name} placeholder in an English message also appears in its pt-BR message', () => {
  const missing: string[] = []
  for (const key of Object.keys(MESSAGES.en) as MessageKey[]) {
    const ptNames = placeholdersOf(MESSAGES.pt[key])
    for (const name of placeholdersOf(MESSAGES.en[key])) {
      if (!ptNames.includes(name)) missing.push(`${key}:{${name}}`)
    }
  }
  expect(missing).toEqual([])
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
  expect(t('en', 'status.pending', { key: 'A', target: 'app · Build' })).toBe('⏳ Answer A sent to app · Build')
  expect(t('pt', 'status.pending', { key: 'A', target: 'app · Build' })).toBe('⏳ Resposta A enviada para app · Build')
  expect(t('en', 'status.pending', {})).toBe('⏳ Answer {key} sent to {target}')
})

test('t reads a numeric value as its text', () => {
  expect(t('en', 'review.submit', { n: 3 })).toBe('Submit all (3)')
  expect(t('pt', 'review.submit', { n: 3 })).toBe('Enviar tudo (3)')
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
