import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";
import { runRelockTtsTests } from "./run-relock-tts-tests.mjs";
import { runYoutubePublishContractTests } from "./youtube-publish-contract-tests.mjs";

await runRelockTtsTests();
await runYoutubePublishContractTests();
await runFixtureSuite("stage-contract");
