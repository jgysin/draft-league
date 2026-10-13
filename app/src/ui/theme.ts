import { Platform, useColorScheme } from 'react-native';

/** The website's typewriter look: paper, ink, coral and blue, monospaced type. */
const light = {
  paper: '#faf6ef', card: '#fffdf8', ink: '#1c1b1a', muted: '#8a857c', rule: '#d8d2c4',
  coral: '#e4572e', blue: '#2e6fe4', green: '#1f9d55', onAccent: '#ffffff',
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
