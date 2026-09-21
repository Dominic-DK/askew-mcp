import { join } from "node:path";
import { loadOrCreateKeys } from "../../src/keys.js";
import { DurableLocalJournal } from "../../src/local-journal.js";

const directory = process.argv[2]!;
const keys = await loadOrCreateKeys(join(directory, "connector.key"));
await new DurableLocalJournal(keys).run({ connectorId: "mac", routeId: "route", shortcutName: "test",
  input: "test", idempotencyKey: "crashed-attempt" }, async () => {
  process.send?.("dispatched");
  setInterval(() => {}, 1_000);
  return await new Promise<string>(() => {});
});
