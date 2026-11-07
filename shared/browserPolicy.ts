import type {Plugin} from 'vite';

/** Build-only: development keeps Vite's local refresh/WebSocket behavior. */
export function productionBrowserPolicy(): Plugin {
  let authDomain = '', projectId = '';
  return {
    name: 'production-browser-security',
    apply: 'build',
    configResolved(config) {
      const domain = config.env.VITE_FIREBASE_AUTH_DOMAIN;
      if (typeof domain === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain)) authDomain = domain;
      const project = config.env.VITE_FIREBASE_PROJECT_ID;
      if (typeof project === 'string' && /^[a-z][a-z0-9-]{4,62}$/.test(project)) projectId = project;
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        const policy = [
          "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' blob:",
          "worker-src 'self' blob:", "manifest-src 'self'",
          `frame-src 'self'${authDomain ? ' https://' + authDomain : ''}`,
          "connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com" +
            (projectId ? ` https://us-central1-${projectId}.cloudfunctions.net` : ''),
          "object-src 'none'", "base-uri 'none'", "form-action 'none'",
        ].join('; ');
        return [
          {tag: 'meta', attrs: {'http-equiv': 'Content-Security-Policy', content: policy}, injectTo: 'head-prepend'},
          {tag: 'meta', attrs: {name: 'referrer', content: 'no-referrer'}, injectTo: 'head-prepend'},
        ];
      },
    },
  };
}
