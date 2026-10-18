// The Askaway palette. The pane takes the theme's own text colours and background: no fill and no box of its own. The
// accent is never a text colour: it marks only the status mark (✓, ⏳, ⚠️), a non-text mark that needs 3:1 (WCAG 2.2
// 1.4.11). The terminal logo glyph (logo-element.tsx) still draws it as text.
// Measured WCAG 2.x contrast, before (#1E40AF) and after (#3566C8):
//   on #FFFFFF: 8.72:1 before, 5.40:1 after
//   on #111827: 2.03:1 before, 3.28:1 after
export const ACCENT_COLOR = '#3566C8' as const
// The rule above the nav row of a question card. It is a decorative line, not text, so the 3:1 non-text floor does not
// apply to it: #D1D5DB is about 1.5:1 on white and reads as a hairline.
export const DIVIDER_COLOR = '#D1D5DB' as const
