# PermissionPrompter

`src/permission-prompter.ts`

## Responsibility

`PermissionPrompter` owns the full permission-prompt flow for a single agent request:

1. **Yolo-mode check** — if `yoloMode` is enabled in the active config, auto-approve and write a `permission_request.auto_approved` review-log entry without showing any UI.
2. **Review log — waiting** — write `permission_request.waiting` before any dialog is shown.
3. **UI prompt broadcast** — build the `PermissionUiPromptEvent` once via `buildDirectUiPrompt(details)`.
   When `ctx.hasUI`, emit it on `permissions:ui_prompt` so observers (e.g. notification extensions) know the user must respond.
   A non-UI session does not emit here — the parent emits from the forwarded path instead.
4. **UI/forwarding branch** — delegate to `forwarder.requestApproval()`, which selects the correct path:
   - `ctx.hasUI` → show the interactive dialog.
   - subagent context → write a forwarded-permission request file (carrying the relayed display fields) and poll for the parent session's response.
   - neither → deny immediately.
   The prompter relays the built event's `source`/`surface`/`value` to `requestApproval` so a forwarded request persists them and the parent emits a non-degraded event.
5. **Review log — outcome** — write `permission_request.approved` or `permission_request.denied` with the final decision state and any denial reason.

## Why a class instead of a free function

The previous implementation was `promptPermission(runtime, forwardingDeps, ctx, details)` in `runtime.ts`.
Adding a new field to `PromptPermissionDetails` (e.g. `sessionLabel` in #51) required touching four files: `types.ts` → `runtime.ts` → `polling.ts` → `index.ts`.

With `PermissionPrompter`, adding a new field touches two files:

- `src/handlers/types.ts` — add the field to `PromptPermissionDetails`.
- `src/permission-prompter.ts` — read the new field inside `prompt()`.

Handler code and wiring in `index.ts` are unaffected.

## Interfaces

```typescript
interface PermissionPrompterApi {
  prompt(ctx: ExtensionContext, details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}

interface PermissionPrompterDeps {
  getConfig(): PermissionSystemExtensionConfig;  // yolo-mode check
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  events: PermissionEventBus;                    // permissions:ui_prompt broadcast
  forwarder: ApprovalRequester;                  // UI dialog or subagent forwarding
}
```

`ApprovalRequester` is the narrow seam defined in `src/forwarded-permissions/permission-forwarder.ts`:

```typescript
interface ApprovalRequester {
  requestApproval(
    ctx: ExtensionContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision>;
}
```

## Relationship to the forwarder

`PermissionPrompter` delegates the UI/forwarding decision to the injected `ApprovalRequester`.
It never assembles a forwarding-dependency bag internally — the single `PermissionForwarder` instance (constructed in `index.ts` with its own `PermissionForwarderDeps`) is shared between the prompter and `ForwardingManager`.

Yolo-mode is handled at the prompter level before `requestApproval` is ever reached, so the forwarder always operates in the "ask the user" path when reached from the prompter.

## Wiring

`PermissionPrompter` is instantiated once in `piPermissionSystemExtension()` (`src/index.ts`) after the `PermissionForwarder`, and injected into `PermissionSessionRuntimeDeps.promptPermission`:

```typescript
const forwarder = new PermissionForwarder(forwardingDeps);
const prompter = new PermissionPrompter({ …, forwarder });
// …
promptPermission: (ctx, details) => prompter.prompt(ctx, details),
```

Handler classes call `session.prompt(ctx, details)` which delegates to the injected prompter.
Tests mock `prompt` on the `PermissionSession` mock directly.
