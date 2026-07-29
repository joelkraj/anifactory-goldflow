import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";
import { runRelockTtsTests } from "./run-relock-tts-tests.mjs";

await runRelockTtsTests();
await runFixtureSuite("stage-contract");
