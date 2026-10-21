export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return (
    (value / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 }) +
    ' ' +
    units[index]
  );
}
