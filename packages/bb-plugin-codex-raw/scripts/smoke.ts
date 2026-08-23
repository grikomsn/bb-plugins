import { readFile } from "node:fs/promises";
import { ALL_RAW_TYPES, NOISE_TYPES, UNHANDLED_TYPES } from "../lib/codex-raw-types.ts";

if (ALL_RAW_TYPES.length !== 42) {
  throw new Error(`expected 42 raw types, got ${ALL_RAW_TYPES.length}`);
}
if (UNHANDLED_TYPES.length !== 29 || NOISE_TYPES.length !== 13) {
  throw new Error(
    `unexpected classification counts: ${UNHANDLED_TYPES.length}/${NOISE_TYPES.length}`,
  );
}

const contractSource = await readFile(new URL("../contract.ts", import.meta.url), "utf8");
for (const method of ["rawEvents", "types", "tail", "sessions", "status"]) {
  if (!contractSource.includes(`${method}: {`)) {
    throw new Error(`${method} RPC is missing from contract.ts`);
  }
}

console.log("codex-raw smoke passed: 42 types and 5 required RPC methods");
