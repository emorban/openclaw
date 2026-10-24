import { expectTypeOf, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle-types.js";
import type { CodexAppServerTurnRouter } from "./turn-router.js";

it("requires startup before a prepared attempt can supply live resources", () => {
  type Prepared = ReturnType<typeof prepareCodexAttemptResources>;
  expectTypeOf<Prepared["state"]["client"]>().toEqualTypeOf<CodexAppServerClient | undefined>();
  expectTypeOf<Prepared["state"]["thread"]>().toEqualTypeOf<
    CodexAppServerThreadLifecycleBinding | undefined
  >();
  expectTypeOf<Prepared["state"]["turnRouter"]>().toEqualTypeOf<
    CodexAppServerTurnRouter | undefined
  >();
  expectTypeOf<Prepared>().not.toMatchTypeOf<StartedCodexAttemptResources>();
  expectTypeOf<
    StartedCodexAttemptResources["state"]["client"]
  >().toEqualTypeOf<CodexAppServerClient>();
  expectTypeOf<
    StartedCodexAttemptResources["state"]["thread"]
  >().toEqualTypeOf<CodexAppServerThreadLifecycleBinding>();
  expectTypeOf<
    StartedCodexAttemptResources["state"]["turnRouter"]
  >().toEqualTypeOf<CodexAppServerTurnRouter>();
});
