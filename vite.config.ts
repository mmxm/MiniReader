import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';

// Récupérer le commit git hash actuel
let commitHash = 'unknown';
try {
  commitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {
  // Fallback pour l'environnement de build Vercel
  commitHash = (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').substring(0, 7);
}

// Plugin de proxy local CORS pour simuler le proxy d'API Vercel en développement
function localProxyPlugin() {
  return {
    name: 'local-proxy-plugin',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (req.url && req.url.startsWith('/api/proxy')) {
          const urlObj = new URL(req.url, 'http://localhost');
          const targetUrl = urlObj.searchParams.get('url');
          if (!targetUrl) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing target url parameter' }));
            return;
          }
          
          try {
            const headers: any = {};
            const headersToForward = [
              'content-type',
              'user-agent',
              'x-kobo-synctoken',
              'x-kobo-apitoken',
              'x-kobo-sync'
            ];
            for (const h of headersToForward) {
              const val = req.headers[h];
              if (val) {
                headers[h] = val;
              }
            }
            
            const fetchOptions = {
              method: req.method,
              headers
            };
            
            const targetResponse = await fetch(targetUrl, fetchOptions);
            res.statusCode = targetResponse.status;
            
            const koboHeaders = ['x-kobo-synctoken', 'x-kobo-sync', 'content-type'];
            for (const h of koboHeaders) {
              const val = targetResponse.headers.get(h);
              if (val) {
                res.setHeader(h, val);
              }
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            const buffer = await targetResponse.arrayBuffer();
            res.end(Buffer.from(buffer));
          } catch (error: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message || 'Failed to proxy request' }));
          }
          return;
        }
        next();
      });
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
        navigateFallbackDenylist: [/^\/reader\.html/],
        ignoreURLParametersMatching: [/.*/],
        // S'assurer que le service worker met en cache les couvertures de livres chargées en externe (CORS)
        runtimeCaching: [
          {
            urlPattern: /.*\/thumbnail\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'bookorbit-covers',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 jours
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      manifest: {
        name: 'MiniReader',
        short_name: 'MiniReader',
        description: 'Lecteur d’ebooks PWA synchronisé avec BookOrbit',
        theme_color: '#0a0e17',
        background_color: '#0a0e17',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    }),
    localProxyPlugin()
  ]
});

