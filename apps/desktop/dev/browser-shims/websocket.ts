// Browser stand-in for @tauri-apps/plugin-websocket. Browsers cannot set the
// Authorization header on a WebSocket, so the preview has no live event stream.
type Listener = (message: { type: string; data?: unknown }) => void;
export default class WebSocket {
  static async connect(_url: string, _options?: unknown): Promise<WebSocket> {
    return new WebSocket();
  }
  addListener(_listener: Listener) {
    return () => {};
  }
  async send(_message: unknown) {}
  async disconnect() {}
}
