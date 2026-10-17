// The KeepGlide mark, drawn small in the pane: the hang glider on its navy tile, as an SVG source string.
export const KEEPGLIDE_ALT = 'KeepGlide'

export function keepglideSvg({ size }: { size: number }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="15" fill="#22305F"/>
  <path d="M15.5 25.4 L37.6 21.8 Q40.4 21.7 40.9 24.4 L44.8 43.2 L32.6 31.3 Z" fill="#48C9C1"/>
  <path d="M15.5 25.4 L20.6 24.6 L21.6 27.6 Z" fill="#F4766B"/>
  <path d="M44.8 43.2 L43.6 37.7 L40.8 39.5 Z" fill="#F4766B"/>
  <path d="M31.6 31.6 L29.4 37.6 M31.6 31.6 L34.2 37.6 M28.8 37.6 L34.8 37.6" stroke="#8A93AD" stroke-width="0.9" fill="none"/>
  <path d="M14 43.6 Q20 44.2 26.2 40.2 Q25.6 44 27.6 47" stroke="#2F8F96" stroke-width="0.9" fill="none"/>
  <circle cx="16.7" cy="43.7" r="1.4" fill="#3FD0C8"/>
  <circle cx="21.3" cy="43" r="1.4" fill="#3FD0C8"/>
  <circle cx="26.1" cy="40.2" r="1.4" fill="#3FD0C8"/>
  <circle cx="26.4" cy="45" r="1.4" fill="#3FD0C8"/>
</svg>`
}
