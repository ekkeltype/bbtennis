import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: { main: 'index.html', arcade: 'arcade/index.html' },
    },
  },
  server: { port: 5173 },
});
