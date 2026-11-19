import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: '슝',
        short_name: '슝',
        description: '일정·지도·항공권·가계부를 한 곳에서, 동행인과 같이',
        lang: 'ko',
        start_url: '/',
        display: 'standalone',
        background_color: '#2E5BFF',
        theme_color: '#F2F4F6',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 구글 로그인 처리 경로(/__/auth)는 서비스워커가 가로채지 않게
        navigateFallbackDenylist: [/^\/__\//],
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // 오프라인에서도 글꼴·프로필 사진이 보이게
        runtimeCaching: [
          { urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/gh\/orioncactus\/pretendard\//, handler: 'CacheFirst', options: { cacheName: 'fonts', expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 365 }, cacheableResponse: { statuses: [0, 200] } } },
          { urlPattern: /^https:\/\/lh3\.googleusercontent\.com\//, handler: 'StaleWhileRevalidate', options: { cacheName: 'avatars', expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 }, cacheableResponse: { statuses: [0, 200] } } },
        ],
      },
    }),
  ],
});
