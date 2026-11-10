import { Platform, useColorScheme } from 'react-native';

/**
 * The website's typewriter look: paper, ink, coral and blue, monospaced type.
 * In light mode muted, coral and blue are the website's hues darkened until small
 * text reaches 4.5:1 on paper (WCAG AA): 4.91, 4.70 and 4.85. Dark already passes.
 */
const light = {
  paper: '#faf6ef', card: '#fffdf8', ink: '#1c1b1a', muted: '#706b62', rule: '#d8d2c4',
  coral: '#c4421c', blue: '#2867d8', green: '#1f9d55', onAccent: '#ffffff',
};
const dark: typeof light = {
  paper: '#1a1917', card: '#23211e', ink: '#ede6d8', muted: '#9a9387', rule: '#3a3631',
  coral: '#f0704a', blue: '#6b9cff', green: '#4cc283', onAccent: '#1a1917',
};
export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const font = Platform.select({ ios: 'Courier New', android: 'monospace', default: 'Courier New, monospace' });
export const space = (n: number) => n * 4;
