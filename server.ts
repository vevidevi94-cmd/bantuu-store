import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createApiApp } from './server/apiApp';
import { syncWithRtdbOnBootOrRefresh } from './server/storeDb';

const PORT = 3000;

async function startServer() {
  // Initial sync with Firebase Realtime Database (seeds RTDB if null, or pulls live updates)
  await syncWithRtdbOnBootOrRefresh().catch((err) => {
    console.warn('Initial Firebase RTDB sync warning:', err);
  });

  const app = createApiApp();

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bantuu Store server running at http://localhost:${PORT}`);
  });
}

startServer();
