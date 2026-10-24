import { getEmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { assert, expect, it } from "vitest";

it("resolves google on cold startup without changing the Gemini index identity", async () => {
  const config = {
    plugins: { allow: ["google"], entries: { google: { enabled: true } } },
  };
  const alias = getEmbeddingProvider("google", config);
  const canonical = getEmbeddingProvider("gemini", config);
  assert(alias, "google must resolve to the Gemini embedding adapter");
  assert(canonical);
  expect(alias).toBe(canonical);
  const options = {
    config,
    model: "gemini-embedding-001",
    remote: { apiKey: "synthetic-google-alias-key" },
  };
  const google = await alias.create({ ...options, provider: "google" });
  const gemini = await canonical.create({ ...options, provider: "gemini" });
  expect(google.provider?.id).toBe("gemini");
  expect(google.runtime?.id).toBe("gemini");
  expect(google.runtime?.cacheKeyData).toEqual(gemini.runtime?.cacheKeyData);
});
