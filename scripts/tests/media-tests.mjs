import "./qwen-liam-selection-tests.mjs";
import "./qwen-liam-batch4-tests.mjs";
import "./modelslab-stt-candidate-tests.mjs";
import "./modelslab-account-pool-tests.mjs";
import "./tts-qwen-throughput-bakeoff-tests.mjs";
import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";

await runFixtureSuite("media");
