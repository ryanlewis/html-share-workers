import { Hono } from 'hono';
import api from './api';
import type { AppEnv } from './env';
import serve from './serve';

const app = new Hono<AppEnv>();

app.route('/api', api);
// Anything under /api the API does not handle stops here, so it never
// falls through to serving.
app.all('/api', (c) => c.json({ error: 'not found' }, 404));
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
app.route('/', serve);

export default app;
