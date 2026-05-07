/**
 * Atlas palette — Atlas-blue navy variant for OpenTUI.
 *
 * OpenTUI paints every cell itself, so we use a navy base that reads as
 * Atlas-branded rather than as "the user's terminal bg." All three
 * surface tones step up from the same hue family so panels, elements,
 * and borders remain cohesive.
 */
export const palette = {
  background: '#0b1220',        // navy base — main canvas
  backgroundPanel: '#0f1a2e',   // header / composer / sidebar / statusbar
  backgroundElement: '#142340', // raised tiles inside panels
  primary: '#5c9cf5',
  primaryBright: '#7fb8ff',
  secondary: '#56b6c2',
  accent: '#9d7cd8',
  text: '#eeeeee',
  textMuted: '#9aa6c2',
  textDim: '#6b7896',
  border: '#2a3a5c',
  borderSubtle: '#1c2a48',
  success: '#7fd88f',
  warning: '#f5a742',
  error: '#e06c75',
  info: '#56b6c2',
  neonPower: '#ff315f',
  neonSmart: '#39ff88'
} as const;
