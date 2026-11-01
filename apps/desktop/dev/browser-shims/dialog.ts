// Browser stand-in for @tauri-apps/plugin-dialog.
export const confirm = async (message: string) => window.confirm(message);
export const save = async (_options?: unknown): Promise<string | null> => null;
export const message = async (text: string) => window.alert(text);
