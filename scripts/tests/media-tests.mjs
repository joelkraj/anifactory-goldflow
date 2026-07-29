import "./qwen-liam-selection-tests.mjs";
import "./tts-qwen-throughput-bakeoff-tests.mjs";
import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";

await runFixtureSuite("media");
