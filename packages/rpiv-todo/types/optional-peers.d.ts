/**
 * Ambient stubs for `@juicesharp/rpiv-i18n` — a soft optional peer of this fork.
 * The upstream loads the SDK via a dynamic `await import(...)` wrapped in
 * try/catch; when the SDK is absent the catch branch runs and the extension
 * falls back to English-only UI (see `state/i18n-bridge.ts` and `index.ts`).
 *
 * TypeScript resolves the specifier of a dynamic import statically, so an
 * unresolvable module raises TS2307 ("Cannot find module") even inside a
 * try/catch. These ambient declarations give both entry points a concrete
 * shape so the `as I18nLoader` / `as I18nSDK` casts in the call sites compile,
 * without shipping the (absent) SDK. This file is build infra for the optional
 * peer only — it does not change runtime behavior. If the real SDK is ever
 * installed and resolvable, TypeScript prefers the real declarations over
 * these ambient stubs (a concrete module on disk wins over `declare module`).
 */

// Empty-body ambient declarations make each module a wildcard `any` namespace:
// `await import("...")` resolves to `Promise<any>`, so the `as I18nLoader` /
// `as I18nSDK` casts in `index.ts` and `state/i18n-bridge.ts` succeed. The real
// SDK (if ever installed) takes precedence over these stubs.
declare module "@juicesharp/rpiv-i18n";
declare module "@juicesharp/rpiv-i18n/loader";
