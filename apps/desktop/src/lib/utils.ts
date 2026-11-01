import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The theme's own font-size tokens (styles/tailwind.css `--text-*`). Without them
// tailwind-merge reads `text-caption` as a colour and silently drops `text-ink-2`.
export const fontSizeTokens = ['body', 'caption', 'nav', 'page'];
const twMerge = extendTailwindMerge({ extend: { theme: { text: fontSizeTokens } } });

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
