// Browser stand-in for @tauri-apps/api/window.
export function getCurrentWindow() {
  return {
    isMaximized: async () => false,
    onResized: async (_cb: () => void) => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    startDragging: async () => {},
  };
}
