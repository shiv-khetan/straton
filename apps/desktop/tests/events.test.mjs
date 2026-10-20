import assert from 'node:assert/strict';
import WebSocket from '@tauri-apps/plugin-websocket';
import { subscribe } from '../src/api.ts';
const originalConnect = WebSocket.connect;
const originalSet = globalThis.setTimeout,
  originalClear = globalThis.clearTimeout;
const timers = new Map();
let nextTimer = 0;
globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimer;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const calls = [],
  events = [],
  states = [],
  listeners = new Set();
let closed = 0;
const socket = {
  addListener(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  async disconnect() {
    closed++;
  },
};
try {
  WebSocket.connect = async (url, config) => {
    calls.push({ url, config });
    if (calls.length <= 2) throw new Error('offline');
    return socket;
  };
  const stop = subscribe(
    { url: 'https://engine.example', token: 'private-test-token' },
    (event) => events.push(event),
    (state) => states.push(state),
  );
  await tick();
  assert.equal([...timers.values()][0].delay, 1000);
  let retry = [...timers.entries()][0];
  timers.delete(retry[0]);
  retry[1].callback();
  await tick();
  assert.equal([...timers.values()][0].delay, 2000);
  retry = [...timers.entries()][0];
  timers.delete(retry[0]);
  retry[1].callback();
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'wss://engine.example/v1/events');
  assert.equal(calls[0].config.headers.Authorization, 'Bearer private-test-token');
  assert.equal(states.at(-1), 'Live');
  assert.equal(events[0].type, 'resync_required');
  for (const listener of listeners) {
    listener({ type: 'Text', data: 'invalid' });
    listener({ type: 'Text', data: '{"type":"catalog.changed"}' });
  }
  assert.equal(events.at(-1).type, 'catalog.changed');
  assert.equal(events.length, 2);
  for (const listener of listeners) listener({ type: 'Close', data: null });
  assert.equal([...timers.values()][0].delay, 4000);
  stop();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  let resolvePending;
  WebSocket.connect = () =>
    new Promise((resolve) => {
      resolvePending = resolve;
    });
  const stopPending = subscribe(
    { url: 'http://localhost:8787', token: 'test' },
    () => {},
    () => {},
  );
  stopPending();
  resolvePending(socket);
  await tick();
  assert.equal(closed, 1);
  assert.equal(timers.size, 0);
  console.log('Event Authorization, backoff, resync, malformed frame and disposal checks passed.');
} finally {
  WebSocket.connect = originalConnect;
  globalThis.setTimeout = originalSet;
  globalThis.clearTimeout = originalClear;
}
