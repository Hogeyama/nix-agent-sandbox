/** Ports nas binds inside the agent's network namespace. */

/**
 * Default port of the loopback HTTP proxy the agent's traffic goes through.
 * `local-proxy.mjs` honours NAS_LOCAL_PROXY_PORT, so this is the default the
 * pipeline seeds rather than an invariant.
 */
export const LOCAL_PROXY_PORT = 18080;
