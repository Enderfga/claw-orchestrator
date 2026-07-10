const AGY_CONVERSATION_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const AGY_CONVERSATION_ID_RE = new RegExp(`^${AGY_CONVERSATION_ID_SOURCE}$`, 'i');
const AGY_CREATED_CONVERSATION_RE = new RegExp(`Created conversation (${AGY_CONVERSATION_ID_SOURCE})`, 'i');

export function isAgyConversationId(value: string | undefined): value is string {
  return !!value && AGY_CONVERSATION_ID_RE.test(value);
}

export function extractCreatedAgyConversationId(log: string): string | undefined {
  return log.match(AGY_CREATED_CONVERSATION_RE)?.[1];
}
