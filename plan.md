# Plan — PR #113 maintainer review

## Goal
Aplicar exactamente los tres cambios que pidió @Enderfga en https://github.com/Enderfga/claw-orchestrator/pull/113#issuecomment-5775492485 sobre la rama `fix/agy-tool-permission-denial-diagnostics`: quitar del PR los artefactos de trabajo de Autoloop, mover la entrada de CHANGELOG fuera de la versión ya publicada 7.5.1, y echoar nombres de herramientas denegadas en el error de empty-response solo cuando parezcan un identificador.

## Scope
- In:
  - `git rm plan.md goal.json` en la raíz. Confirmar `git ls-files -- plan.md goal.json` vacío. No añadir entradas a `.gitignore`. No borrar menciones documentales de `plan.md`/`goal.json` en autoloop, council u otros archivos.
  - En `CHANGELOG.md`: cortar el único bullet **Antigravity empty-response errors now name the denied tools.** de `## [7.5.1] - 2026-09-20` y crear encima `## [Unreleased]` con `### Fixed` conteniendo solo esa entrada (mismo texto). No tocar el resto de `[7.5.1]`.
  - En `src/persistent-agy-session.ts`, rama `else if (emptyResponse)` (aprox. 403-410): filtrar `permissionDenials` con `/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/` antes de meter nombres en el mensaje. Si la lista filtrada tiene >=1 elemento, usar el mensaje específico ya existente con esos nombres; si queda vacía, `TOOL_DENIAL_EMPTY_RESPONSE_ERROR` sin cambios. Filtro todo-o-nada por nombre (no truncar ni sanitizar carácter a carácter).
  - Test nuevo en `src/__tests__/agy-session.test.ts` junto al de `RunCommand` (aprox. 444-496): mismo escenario empty-response + log `soft-denying tool confirmation`; el nombre entre comillas no es identificador (espacios o más de 64 caracteres). El mensaje es el genérico y no contiene ese valor. El test de `RunCommand` sigue exigiendo el mensaje específico con `"RunCommand"`.
  - Verificar con `npm run build && ./node_modules/.bin/eslint src/ bin/ && npm run format:check && ./node_modules/.bin/vitest run` (bins locales si PATH falla), luego `git push origin HEAD` en esta rama. No abrir un PR nuevo. No force-push.
- Out:
  - `src/agy-conversation.ts` (la regex de extracción 1-256 se queda a propósito).
  - Filtrar `event.permission_denials` / `SendResult.permissionDenials`.
  - Renombrar o reescribir las constantes/mensajes genérico y específico.
  - Bump de versión, otros bullets de CHANGELOG, `.gitignore`, PR nuevo.

## Success criteria
- Scalar: none (solo gates)
- Gates:
  - [ ] G1: `plan.md` y `goal.json` no están en el índice git — eval: `bash -c 'test -z "$(git ls-files -- plan.md goal.json)"'`
  - [ ] G2: `## [Unreleased]` es la primera sección de versión, contiene esa entrada bajo `### Fixed`, y `[7.5.1]` ya no la contiene — eval: gate `changelog_unreleased` en goal.json
  - [ ] G3: el regex de identificador vive en `src/persistent-agy-session.ts` — eval: `grep -F '/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/' src/persistent-agy-session.ts`
  - [ ] G4: `./node_modules/.bin/vitest run src/__tests__/agy-session.test.ts` exit 0
  - [ ] G5: `npm run build && ./node_modules/.bin/eslint src/ bin/ && npm run format:check && ./node_modules/.bin/vitest run` exit 0 (suite completa, sin `--exclude`)

## Constraints
- Files not to touch: todo excepto `src/persistent-agy-session.ts`, `src/__tests__/agy-session.test.ts`, `CHANGELOG.md`, y el `git rm` de `plan.md` / `goal.json`.
- Banned: editar `src/agy-conversation.ts`; truncar nombres; filtrar `permission_denials` del evento; force-push; abrir otro PR; bump de versión; añadir `.gitignore` para estos dos archivos.
- Excepción Autoloop: el Coder SÍ debe `git rm plan.md goal.json`. Aquí son el defecto del PR, no el ledger. El Reviewer no rechaza ese rm.
- Push: `git push origin HEAD` a `fix/agy-tool-permission-denial-diagnostics` (origin = ajmtrz/claw-orchestrator). Paso del Coder, no gate del Reviewer.

## Approach (Coder hint)
En `emptyResponse`, `echoableDenials = permissionDenials.filter(name => AGY_ECHOABLE_TOOL_NAME_RE.test(name))` y esa lista decide el mensaje específico. El evento sigue publicando los nombres crudos. El test nuevo clona el primer send del de RunCommand con un nombre inválido (p.ej. `not a tool`). Mover el bullet de CHANGELOG sin reescribirlo. `git rm` en el árbol del PR, verificar, push.

## Reviewer rubric (extra)
- Flag si el error echoa un nombre que no matchea el regex.
- Flag si se tocó `src/agy-conversation.ts` o se filtró `event.permission_denials`.
- Flag si el bullet sigue en `[7.5.1]` o si `[7.5.1]` perdió otros bullets.
- Flag si el test de RunCommand ya no exige `"RunCommand"` en el mensaje.
- Flag si G5 usó `--exclude` (host-strategy u otro).
- Aceptar `git rm plan.md goal.json` (G1). No exigir que sigan en el working tree.
- No aceptar `.gitignore` nuevo, bump de versión, ni un PR distinto de #113.
