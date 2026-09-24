import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // .ttf isn't in Vite's default asset list — needed for the DejaVu Serif font that
  // pdf-export.js embeds via `?url` imports (see src/writing/fonts/).
  assetsInclude: ['**/*.ttf'],
});
