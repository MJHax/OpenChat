import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Libraries get their own files, so an update to OpenChat's own code doesn't re-download them.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/]node_modules[\\/](highlight\.js|lowlight|react-markdown|rehype-|remark-|micromark|mdast-|hast-|unified|unist-)/.test(id)) return 'markdown';
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.OPENCHAT_PORT ?? 3000}` },
  },
});
