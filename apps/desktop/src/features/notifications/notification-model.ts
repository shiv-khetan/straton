export async function openNotification(
  notification: { id: string; read: boolean; entity_kind: string; entity_id: string },
  {
    readOnly,
    onEntity,
    markRead,
    onReadError,
  }: {
    readOnly: boolean;
    onEntity: (kind: string, id: string) => Promise<void>;
    markRead?: (id: string) => Promise<unknown>;
    onReadError: (error: unknown) => void;
  },
) {
  const navigation = onEntity(notification.entity_kind, notification.entity_id);
  if (!readOnly && !notification.read && markRead) {
    void Promise.resolve()
      .then(() => markRead(notification.id))
      .catch(onReadError);
  }
  await navigation;
}
