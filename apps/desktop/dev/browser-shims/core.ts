// Browser stand-in for @tauri-apps/api/core. Dev preview only: never part of a build.
declare const __STRATON_DEV_TOKEN__: string;
export const isTauri = () => true;
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case 'load_connection':
      return (
        __STRATON_DEV_TOKEN__ ? { url: window.location.origin, token: __STRATON_DEV_TOKEN__ } : null
      ) as T;
    case 'save_connection':
    case 'forget_connection':
    case 'save_export':
      return undefined as T;
    default:
      throw new Error('Not available in the browser preview: ' + cmd + JSON.stringify(args ?? {}));
  }
}
