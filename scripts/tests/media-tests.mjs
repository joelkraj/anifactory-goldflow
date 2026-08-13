import "./qwen-liam-selection-tests.mjs";
import "./qwen-liam-batch4-tests.mjs";
import "./modelslab-stt-candidate-tests.mjs";
import "./modelslab-account-pool-tests.mjs";
import "./tts-qwen-throughput-bakeoff-tests.mjs";
import "./ltx-video-tests.mjs";
import "./ltx-video-recovery-tests.mjs";
import "./operator-motion-route-override-tests.mjs";
import "./operator-image-route-override-tests.mjs";
import "./render-duration-integrity-tests.mjs";
import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";

await runFixtureSuite("media");
