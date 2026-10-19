// Private, paused staging only. This entrypoint cannot enable benchmarks.
// The reviewed product and ledger remain unchanged.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuration } from "./security.mjs";
import { databasePool, Ledger, migrate } from "./ledger.mjs";
import { webServer } from "./server.mjs";
import { fakeProvider } from "./fake-provider.mjs";

export function stagingConfiguration(env = process.env) {
  if (
    env.STAGING_ONLY !== "1" ||
    env.OPENAI_API_KEY ||
    (env.BETA_MODE && env.BETA_MODE !== "live") ||
    (env.BETA_KILL_SWITCH && env.BETA_KILL_SWITCH !== "1")
  ) {
    throw new Error(
      "Staging requires no OpenAI key and an enabled kill switch.",
    );
  }
  return configuration({
    ...env,
    BETA_MODE: "live",
    BETA_KILL_SWITCH: "1",
    // Internal placeholder only; never loaded from a secret or used on a network.
    OPENAI_API_KEY: "staging-fake-provider-only",
  });
}

export function stagingFetch(fetchImpl) {
  return (url, options) => {
    if (
      String(url) !==
        "https://challenges.cloudflare.com/turnstile/v0/siteverify" ||
      options?.method !== "POST" ||
      options?.redirect !== "error"
    ) {
      throw new Error("External fetch blocked by staging.");
    }
    return fetchImpl(url, options);
  };
}

export async function stagingServer(config, ledger) {
  if (config.allowed() || !(await ledger.status()).killed) {
    throw new Error("Staging must remain paused.");
  }
  // Keep real hostname/action/token validation; only the model provider is fake.
  return webServer({ config, ledger, provider: fakeProvider() });
}

export async function stagingCommand(command, ledger, pool) {
  if (command === "migrate") return migrate(pool);
  if (command === "initialize") {
    await ledger.initialize();
    return "Staging ledger initialized paused.";
  }
  if (command === "kill") {
    await ledger.switch(true);
    return "Staging kill switch enabled.";
  }
  if (command === "status") return ledger.status();
  throw new Error("Unsupported staging command.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let pool;
  try {
    const config = stagingConfiguration();
    globalThis.fetch = stagingFetch(globalThis.fetch);
    pool = databasePool(config.databaseUrl);
    const ledger = new Ledger(pool, config);
    const command = process.argv[2] ?? "serve";
    if (command === "serve") {
      const server = await stagingServer(config, ledger);
      server.on("error", () => {
        console.error("Private staging startup failed.");
        void pool.end();
        process.exitCode = 1;
      });
      server.listen(config.port, "0.0.0.0", () =>
        console.log(
          "Private staging started: fake provider, admissions paused.",
        ),
      );
      const stop = () => {
        server.close(() => void pool.end());
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    } else {
      console.log(JSON.stringify(await stagingCommand(command, ledger, pool)));
      await pool.end();
    }
  } catch {
    console.error(
      "Private staging blocked. Check paused configuration and database.",
    );
    await pool?.end();
    process.exitCode = 1;
  }
}
