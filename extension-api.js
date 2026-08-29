// @ts-check

/**
 * The standard WebExtensions namespace is `browser`, while Chromium also
 * exposes `chrome`. Firefox keeps a compatible `chrome` alias, but using one
 * shared reference makes browser-specific capabilities explicit.
 */
export const extensionApi = globalThis.browser ?? globalThis.chrome;
