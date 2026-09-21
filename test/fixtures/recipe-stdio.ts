// Injectable builder keeps stdio coverage independent of macOS/signing/installing/running.
import { serveStdio, configFromEnv } from "../../src/index.js";
await serveStdio(configFromEnv(), {
  buildRecipe: async (name) => ({
    name, warnings: [], signedPath: "/test/recipe.shortcut", signedB64: Buffer.from("test file").toString("base64"),
    workflow: { WFWorkflowActions: [] }, imported: true, ran: true,
    output: "PRIVATE_CALENDAR_OUTPUT_NEVER_UPLOAD", error: name === "fail-build" ? "test build failed" : null,
  }),
});
