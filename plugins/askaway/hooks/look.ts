// The Askaway palette. Every status line (sent, delivered and expired) takes this one background and ink pair, and the
// ink clears the WCAG AA floor of 4.5:1 on its background (ratio in the comment). The rest of the pane takes the
// theme's own text colours.
// #166534 on #DCFCE7 is 6.49:1: the mock's one green.
export const STATUS_COLORS = { bg: '#DCFCE7', ink: '#166534' } as const
// The card header (number · project · session title) in the theme's magenta, bold, so the asking window is read first.
export const ORIGIN_COLOR = 'magenta' as const
