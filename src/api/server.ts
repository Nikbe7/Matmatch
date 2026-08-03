import { createTokenVerifier, tokenVerifierConfigFromEnv } from "../auth/verifyToken.js";
import { connectionStringFromEnv, createDbClient } from "../db/client.js";
import { loadEngineData } from "../engine/data.js";
import { createApp } from "./app.js";

// The only module that reads process.env or calls .listen(). Engine data is loaded
// once here, at process start, and handed to every request — re-reading ~600 rows of
// static JSON per request would be pointless I/O (requirement 7).

async function main() {
  const port = Number(process.env.PORT ?? 3000);

  const engineData = await loadEngineData();
  const sql = createDbClient({ connectionString: connectionStringFromEnv() });
  const verifyToken = createTokenVerifier(tokenVerifierConfigFromEnv());

  const app = createApp({ sql, engineData, verifyToken });

  app.listen(port, () => {
    console.log(`matmatch api listening on :${port}`);
  });
}

main().catch((error: unknown) => {
  console.error("failed to start server", error);
  process.exitCode = 1;
});
