export const checksPerPage = 25;

export function checkPage<T>(checks: T[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(checks.length / checksPerPage));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  return { page, pages, rows: checks.slice(page * checksPerPage, (page + 1) * checksPerPage) };
}
