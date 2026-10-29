export function offlineMessage(readOnly: boolean, data: unknown, subject: string) {
  if (!readOnly) return null;
  return data == null ? 'Offline — reconnect to load ' + subject : 'Cached · offline';
}
