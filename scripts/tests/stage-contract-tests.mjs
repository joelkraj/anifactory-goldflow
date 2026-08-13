import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";
import { runRelockTtsTests } from "./run-relock-tts-tests.mjs";
import { runWinnerSourceCliTests } from "./winner-source-cli-tests.mjs";
import { runWinnerSourceContractTests } from "./winner-source-contract-tests.mjs";
import { runWinnerSourceRoomV2ContractTests } from "./winner-source-room-v2-contract-tests.mjs";
import { runWinnerSourceRoomV2LineageTests } from "./winner-source-room-v2-lineage-tests.mjs";
import { runYoutubePublishContractTests } from "./youtube-publish-contract-tests.mjs";
import { runContentProfileTests } from "./content-profile-tests.mjs";

await runContentProfileTests();
await runRelockTtsTests();
await runWinnerSourceContractTests();
await runWinnerSourceRoomV2ContractTests();
await runWinnerSourceRoomV2LineageTests();
await runWinnerSourceCliTests();
await runYoutubePublishContractTests();
await runFixtureSuite("stage-contract");
