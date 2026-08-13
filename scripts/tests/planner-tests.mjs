import { runFixtureSuite } from "../goldflow-fixture-tests.mjs";
import "./planning-runtime-policy-tests.mjs";
import "./source-viewer-tournament-tests.mjs";
import "./source-viewer-profile-bank-tests.mjs";
import "./source-name-familiarity-tests.mjs";

await runFixtureSuite("planner");
