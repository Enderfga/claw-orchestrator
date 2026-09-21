# Plan — Diagnóstico de Tool Permission Denial en PersistentAgySession

## Goal
Incluir los nombres de las herramientas denegadas en el mensaje de error al rechazar turnos por respuesta vacía en PersistentAgySession (`src/persistent-agy-session.ts`), reemplazando el mensaje genérico estático por un diagnóstico descriptivo cuando existan herramientas detectadas, manteniendo el fallback genérico seguro cuando no haya nombres parseables, actualizando el test existente en `src/__tests__/agy-session.test.ts` y documentando el cambio en `CHANGELOG.md`.

## Scope
- In:
  - Modificar la rama `else if (emptyResponse)` en `src/persistent-agy-session.ts` para que, cuando `permissionDenials.length > 0`, construya el mensaje de error incluyendo los nombres de herramientas formateados: `Antigravity returned an empty response after denying tool confirmation for "X", "Y"; the turn failed but the session remains available for retry`.
  - Mantener el fallback al mensaje genérico `TOOL_DENIAL_EMPTY_RESPONSE_ERROR` si `hasAgyToolPermissionDenial(turnLog ?? '')` es true pero `permissionDenials.length === 0`.
  - Actualizar `src/__tests__/agy-session.test.ts` (~L468) para reflejar el nuevo mensaje con `"RunCommand"` y retirar la aserción obsoleta `not.toContain('RunCommand')`.
  - Agregar una entrada técnica en `CHANGELOG.md` bajo `### Fixed`.
  - Validar suite de pruebas (excluyendo el test no relacionado preexistente `src/__tests__/ultraapp/host-strategy.test.ts`).
- Out:
  - No modificar `src/agy-conversation.ts`.
  - No incluir modificaciones en `package-lock.json` ni archivos auxiliares como `coder_notes.md` en el commit.
  - No modificar archivos fuera de los 3 permitidos.

## Success criteria
- Scalar: none
- Gates:
  - [x] G1: Error ante respuesta vacía con tool denegada reporta nombres formateados — eval: `npx vitest run src/__tests__/agy-session.test.ts` pasa 44/44 exit 0 (aprobado en iter 0).
  - [x] G2: Limpieza de scope leak — eval: `git diff` del run solo contiene `src/persistent-agy-session.ts`, `src/__tests__/agy-session.test.ts` y `CHANGELOG.md` (aprobado en iter 1).
  - [x] G3: Verificación completa de suite — eval: `npm run build && npm run lint && npm run format:check && npx vitest run --exclude '**/host-strategy.test.ts'` con salida 0 (aprobado en iter 1).

## Constraints
- Files not to touch: Todos excepto `src/persistent-agy-session.ts`, `src/__tests__/agy-session.test.ts` y `CHANGELOG.md`.
- Banned: Modificar `src/agy-conversation.ts`, alterar el manejo de la sesión persistente, introducir dependencias externas.

## Approach (Coder hint)
Implementación completada en iter 0 y saneada en iter 1. Todos los criterios de aceptación y gates han sido auditados y superados con veredicto `advance`.

## Reviewer rubric (extra)
- Todos los gates pasaron la auditoría independiente del Reviewer en iter 1.
