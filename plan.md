# Plan — Diagnóstico de Tool Permission Denial en PersistentAgySession

## Goal
Incluir los nombres de las herramientas denegadas en el mensaje de error al rechazar turnos por respuesta vacía en PersistentAgySession (`src/persistent-agy-session.ts`), reemplazando el mensaje genérico estático por un diagnóstico descriptivo cuando existan herramientas detectadas, manteniendo el fallback genérico seguro cuando no haya nombres parseables, actualizando el test existente en `src/__tests__/agy-session.test.ts` y documentando el cambio en `CHANGELOG.md`.

## Scope
- In:
  - Modificar la rama `else if (emptyResponse)` en `src/persistent-agy-session.ts` para que, cuando `permissionDenials.length > 0`, construya el mensaje de error incluyendo los nombres de herramientas formateados: `Antigravity returned an empty response after denying tool confirmation for "X", "Y"; the turn failed but the session remains available for retry`.
  - Mantener el fallback al mensaje genérico `TOOL_DENIAL_EMPTY_RESPONSE_ERROR` si `hasAgyToolPermissionDenial(turnLog ?? '')` es true pero `permissionDenials.length === 0`.
  - Actualizar `src/__tests__/agy-session.test.ts` (~L468) para reflejar el nuevo mensaje con `"RunCommand"` y retirar la aserción obsoleta `not.toContain('RunCommand')`.
  - Agregar una entrada técnica en `CHANGELOG.md` bajo `### Fixed`.
  - Validar suite: `npm run build && npm run lint && npm run format:check && npm run test`.
- Out:
  - No modificar `src/agy-conversation.ts` (lógica de extracción/regex ya validada).
  - No tocar el mapeo de `--dangerously-skip-permissions` ni bypass de permisos.
  - No tocar ningún otro test ni archivo fuera del alcance especificado.

## Success criteria
- Scalar: none
- Gates:
  - [ ] G1: Error ante respuesta vacía con tool denegada reporta nombres formateados — eval: `npx vitest run src/__tests__/agy-session.test.ts` pasa con la aserción actualizada.
  - [ ] G2: Fallback genérico preservado si hay denial sin nombre parseable — eval: inspección de la condición en `src/persistent-agy-session.ts`.
  - [ ] G3: Registro de cambio en `CHANGELOG.md` — eval: `git diff CHANGELOG.md` contiene entrada en `### Fixed`.
  - [ ] G4: Verificación completa de suite — eval: `npm run build && npm run lint && npm run format:check && npm run test` con salida 0.

## Constraints
- Files not to touch: Todos excepto `src/persistent-agy-session.ts`, `src/__tests__/agy-session.test.ts` y `CHANGELOG.md`.
- Banned: Modificar `src/agy-conversation.ts`, alterar el manejo de la sesión persistente, introducir dependencias externas.

## Approach (Coder hint)
En `src/persistent-agy-session.ts:403-408`, aprovechar `permissionDenials` calculado en L382. Si `permissionDenials.length > 0`, formatear el mensaje con las herramientas entre comillas dobles unidas por coma. Si `permissionDenials.length === 0` pero `hasAgyToolPermissionDenial(turnLog ?? '')` es verdadero, usar `TOOL_DENIAL_EMPTY_RESPONSE_ERROR`; en caso contrario `EMPTY_RESPONSE_ERROR`. Actualizar `src/__tests__/agy-session.test.ts:468-471` sustituyendo el mensaje esperado y eliminando el `not.toContain`.

## Reviewer rubric (extra)
- Comprobar que `src/agy-conversation.ts` quede intacto.
- Asegurar que el fallback a `TOOL_DENIAL_EMPTY_RESPONSE_ERROR` funcione si `permissionDenials` viene vacío pero el log tiene la marca de denegación.
- Confirmar que ningún otro test de `agy-session.test.ts` haya sido modificado ni relajado.
- Validar que la entrada en `CHANGELOG.md` sea concisa y descriptiva sin lenguaje de marketing.
