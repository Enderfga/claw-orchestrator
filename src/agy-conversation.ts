const AGY_CONVERSATION_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const AGY_CONVERSATION_ID_RE = new RegExp(`^${AGY_CONVERSATION_ID_SOURCE}$`, 'i');
const AGY_CREATED_CONVERSATION_RE = new RegExp(`Created conversation (${AGY_CONVERSATION_ID_SOURCE})`, 'i');
const AGY_TOOL_PERMISSION_DENIAL_RE =
  /tool_confirmation_manager\.go:\d+\][^\r\n]*\bmode:\s+soft-denying tool confirmation\b/i;
const AGY_TOOL_PERMISSION_DENIAL_NAME_RE =
  /tool_confirmation_manager\.go:\d+\][^\r\n]*\bmode:\s+soft-denying tool confirmation\s+"([^"\r\n]{1,256})"/gi;

export function isAgyConversationId(value: string | undefined): value is string {
  return !!value && AGY_CONVERSATION_ID_RE.test(value);
}

export function extractCreatedAgyConversationId(log: string): string | undefined {
  return log.match(AGY_CREATED_CONVERSATION_RE)?.[1];
}

/**
 * Recognize agy's own tool-confirmation denial record without returning any
 * native-log content. Keep this deliberately narrow: an ordinary log line
 * containing words such as "denied" or "permission" must not change the
 * user-facing diagnosis.
 */
export function hasAgyToolPermissionDenial(log: string): boolean {
  return AGY_TOOL_PERMISSION_DENIAL_RE.test(log);
}

/** Return the refused tool names agy 1.2.2 records on the current turn. */
export function extractAgyToolPermissionDenials(log: string): string[] {
  return [...log.matchAll(AGY_TOOL_PERMISSION_DENIAL_NAME_RE)].map((match) => match[1]);
}
