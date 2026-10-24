import { createApp } from './app.js';

const app = await createApp();

try {
  await app.listen({ host: '127.0.0.1', port: 3001 });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
