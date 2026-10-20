import type { UrgencyGrade } from '../types'

// The Askaway palette. The pane takes the theme's own text colours and background, with no fill of its own, except the
// details block of a card: it takes the engine's user-message background (DETAILS_FILL). The accent is never a text colour; no
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
// The fill of the details block: the engine's theme key for the surface of the user's message. The engine resolves it for
// the effective theme, including `auto` (resolved by the Desktop to its system theme), so the mod names no theme and reads
// no theme row.
export const DETAILS_FILL = 'userMessageBackground' as const
// The Urgency text's colour by grade: the engine's theme keys, so it follows light and dark as the diff numbers do.
export const URGENCY_COLOR: Readonly<Record<UrgencyGrade, string>> = { low: 'success', medium: 'warning', high: 'error' }
// Measured WCAG 2.x contrast of the text colours the pane draws, in the engine binary, light and dark themes (backgrounds
// #FFFFFF and #111827). Each text colour must stay at 4.5:1 or better (WCAG 2.2 1.4.3). `dim` is the engine's dim line, a 50%
// blend of the text colour: it fails 4.5:1 on white, so the footer is drawn without it (M68).
export const TEXT_CONTRAST: Readonly<Record<'light' | 'dark', Readonly<Record<string, number>>>> = {
  light: { text: 21, success: 5.32, warning: 4.71, error: 6.67, dim: 3.95 },
  dark: { text: 17.74, success: 7.21, warning: 10.88, error: 6.48, dim: 5.25 },
}
