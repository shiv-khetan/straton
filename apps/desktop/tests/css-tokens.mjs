// Reads the design tokens from tailwind.css. Colour tokens are defined once as
// light-dark(<light>, <dark>); this returns one flat palette per appearance.
export function themeTokens(css) {
  const block = css.match(/:root\s*\{([^}]+)\}/)[1];
  const root = Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim(),
    ]),
  );
  const side = (value, index) => {
    const m = value.match(/^light-dark\((.*)\)$/);
    if (!m) return value;
    let depth = 0;
    for (let i = 0; i < m[1].length; i++) {
      const c = m[1][i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) return (index ? m[1].slice(i + 1) : m[1].slice(0, i)).trim();
    }
    throw new Error('Malformed light-dark(): ' + value);
  };
  const pick = (index) => Object.fromEntries(Object.entries(root).map(([k, v]) => [k, side(v, index)]));
  return { light: pick(0), dark: pick(1) };
}
