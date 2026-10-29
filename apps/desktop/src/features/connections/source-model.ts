type Config = Record<string, string | number | boolean | string[]>;
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '::1', '0:0:0:0:0:0:0:1'].includes(name)) return true;
  const parts = name.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}
export function databaseSslMode(kind: string, config: Config): string {
  const postgres = kind === 'postgres';
  const mode = config[postgres ? 'sslmode' : 'ssl_mode'];
  if (typeof mode === 'string') return mode;
  return isLocalHost(String(config.host ?? 'localhost'))
    ? postgres
      ? 'prefer'
      : 'preferred'
    : postgres
      ? 'require'
      : 'required';
}
export function mongoTlsDefault(config: Config): boolean {
  const hosts = (config.hosts as string[] | undefined) ?? [String(config.host ?? '')];
  return (
    !hosts.length ||
    !hosts.every((h) =>
      isLocalHost(h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]),
    )
  );
}
