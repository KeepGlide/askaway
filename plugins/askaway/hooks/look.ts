// The Askaway palette. Every status line (sent, delivered and expired) takes this one background and ink pair, and the
// ink clears the WCAG AA floor of 4.5:1 on its background (ratio in the comment). The rest of the pane takes the
// theme's own text colours.
// #166534 on #DCFCE7 is 6.49:1: the mock's one green.
export const STATUS_COLORS = { bg: '#DCFCE7', ink: '#166534' } as const
// The accent: the tree's group row, the mark of the question on screen and the terminal logo glyph. #1E40AF is 8.72:1
// on #FFFFFF (AA for text). It is 2.03:1 on a dark background, so on a dark theme the accent is below the floor.
export const ACCENT_COLOR = '#1E40AF' as const
// The explanation box under a question: its ink on its light blue ground. #1F2937 is 13.49:1 on #EFF6FF.
export const EXPLAIN_COLORS = { bg: '#EFF6FF', ink: '#1F2937' } as const
// The rule above the nav row of a question card. It is a decorative line, not text, so the 3:1 non-text floor does not
// apply to it: #D1D5DB is about 1.5:1 on white and reads as a hairline.
export const DIVIDER_COLOR = '#D1D5DB' as const
