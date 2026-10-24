// Serveur local (`npm run dev`) : même application que sur Vercel, servie par Node.
import { serve } from "@hono/node-server";
import app from "./index.js";

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`API data-dz : http://localhost:${port} (docs : /docs)`));
