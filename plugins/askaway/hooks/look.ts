import type { UrgencyGrade } from '../types'

// The Askaway palette. The pane takes the theme's own text colours and background, with no fill of its own, except the
// details block of a card: it takes the fill of its theme family (DETAILS_FILL). The accent is never a text colour; no
// element draws it today (the history rows that took it are plain since 0.4.0-beta.19). It stays measured for a non-text
// mark, which needs 3:1 (WCAG 2.2 1.4.11).
// Measured WCAG 2.x contrast, before (#1E40AF) and after (#3566C8):
//   on #FFFFFF: 8.72:1 before, 5.40:1 after
//   on #111827: 2.03:1 before, 3.28:1 after
export const ACCENT_COLOR = '#3566C8' as const
// The rule above the nav row of a question card. It is a decorative line, not text, so the 3:1 non-text floor does not
// apply to it: #D1D5DB is about 1.5:1 on white and reads as a hairline.
export const DIVIDER_COLOR = '#D1D5DB' as const
// The mark before a clickable row or link: a small square, drawn dim. With the Desktop's own link look (dotted,
// underlined text after it), a clickable row reads as a link, as a native one does.
export const LINK_MARK = '▪' as const
// The theme families. The engine's theme row names the theme ("dark", "light-ansi", ...): a name starting with "light" is
// light, a name starting with "dark" (or no row at all) is dark. Any other value ("auto", "custom:<slug>") is not resolved
// to a family: it is 'unknown', and the details block draws no fill for it, so the engine's own theme shows through.
export type ThemeFamily = 'dark' | 'light' | 'unknown'
type FilledThemeFamily = Exclude<ThemeFamily, 'unknown'>
export const themeFamilyOf = (name: unknown): ThemeFamily => {
  if (typeof name !== 'string') return 'dark'
  if (name.startsWith('light')) return 'light'
  return name.startsWith('dark') ? 'dark' : 'unknown'
}
// The fill of the details block, by theme family: the same fill the engine's band above the prompt has. The dark value
// was measured on the Desktop; the light value is provisional.
export const DETAILS_FILL: Readonly<Record<FilledThemeFamily, string>> = { dark: '#282828', light: '#EEEDE9' }
// The Urgency text's colour by grade: the engine's theme keys, so it follows light and dark as the diff numbers do.
export const URGENCY_COLOR: Readonly<Record<UrgencyGrade, string>> = { low: 'success', medium: 'warning', high: 'error' }
