// Browser stand-in for @tauri-apps/plugin-http; the dev server proxies /v1 to the engine.
export function fetch(input: string, init: RequestInit & Record<string, unknown> = {}) {
  const { method, headers, body } = init;
  return window.fetch(input, { method, headers, body });
}
