import type { Plugin } from "vite";

export function contentSecurityPolicy(isDev: boolean): string {
  const scriptSources = [
    "'self'",
    "'unsafe-eval'",
    "'wasm-unsafe-eval'",
    // Injected by Cloudflare at the edge for hosted builds (Web Analytics).
    "https://static.cloudflareinsights.com",
    ...(isDev ? ["'unsafe-inline'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' * http: https: data: blob: liner-local:",
    "media-src 'self' * http: https: data: blob: liner-local:",
    "connect-src 'self' * http: https: ws: wss: data: blob:",
    // 'self' is the web build's check frame: it loads /__liner/v1/auth/verify
    // from the page's own origin, and without 'self' the directive refuses to
    // frame it, which renders as a blank white box and no Turnstile widget.
    `frame-src 'self' https://*.tryliner.fun${isDev ? " http://localhost:* http://127.0.0.1:*" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

export function contentSecurityPolicyPlugin(): Plugin {
  let isDev = false;
  return {
    name: "liner-content-security-policy",
    configResolved(config) {
      isDev = config.command === "serve";
    },
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: contentSecurityPolicy(isDev),
          },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
