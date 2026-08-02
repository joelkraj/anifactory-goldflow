import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";
import { runRelockTtsTests } from "./run-relock-tts-tests.mjs";
import { runWinnerSourceCliTests } from "./winner-source-cli-tests.mjs";
import { runWinnerSourceContractTests } from "./winner-source-contract-tests.mjs";
import { runYoutubePublishContractTests } from "./youtube-publish-contract-tests.mjs";
import { runContentProfileTests } from "./content-profile-tests.mjs";

await runContentProfileTests();
await runRelockTtsTests();
await runWinnerSourceContractTests();
await runWinnerSourceCliTests();
await runYoutubePublishContractTests();
await runFixtureSuite("stage-contract");
