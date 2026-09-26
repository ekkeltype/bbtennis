import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: { main: 'index.html' },
    },
  },
  server: { port: 5173 },
});
