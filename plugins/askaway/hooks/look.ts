// The Askaway palette. Every status line (sent, delivered and expired) takes this one background and ink pair, and the
// ink clears the WCAG AA floor of 4.5:1 on its background (ratio in the comment). The rest of the pane takes the
// theme's own text colours.
// #166534 on #DCFCE7 is 6.49:1: the mock's one green.
export const STATUS_COLORS = { bg: '#DCFCE7', ink: '#166534' } as const
// The accent is never a text colour: text that used it is bold ink (the theme's own foreground, or EXPLAIN_COLORS.ink
// inside the explanation box), which clears 4.5:1 on each theme. The accent stays on non-text marks, which need 3:1
// (WCAG 2.2 1.4.11). The terminal logo glyph (logo-element.tsx) still draws it as text.
// Measured WCAG 2.x contrast, before (#1E40AF) and after (#3566C8):
//   on #FFFFFF: 8.72:1 before, 5.40:1 after
//   on #111827: 2.03:1 before, 3.28:1 after
export const ACCENT_COLOR = '#3566C8' as const
// The explanation box: #1F2937 on #F9FAFB is 14.05:1 (AA for text), a fixed ink that keeps the text colour on any theme.
export const EXPLAIN_COLORS = { bg: '#F9FAFB', ink: '#1F2937' } as const
// The rule above the nav row of a question card. It is a decorative line, not text, so the 3:1 non-text floor does not
// apply to it: #D1D5DB is about 1.5:1 on white and reads as a hairline.
export const DIVIDER_COLOR = '#D1D5DB' as const
