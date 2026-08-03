#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

const execFile = promisify(execFileCb);
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "../..");
const flags = parseFlags(process.argv.slice(2));
const FPS = 30;
const GRAPHIC_FPS = 12;
const WIDTH = 1920;
const HEIGHT = 1080;
const OPENING_FRAMES = 100;
const DEFAULT_EPISODE_DIR = "/Users/joel/AniFactoryData/channels/assetafterlife/weekly_runs/2026-W31-asset-afterlife-lost-luggage-proof-v5/episodes/ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? DEFAULT_EPISODE_DIR);
const outputDir = path.resolve(flags["output-dir"] ?? path.join(
  episodeDir,
  "review_samples/hybrid_documentary_full_proof_adam_qwen_v1",
));
const proofInputDir = path.resolve(flags["input-dir"] ?? outputDir);
const proofVersion = flags["proof-version"] ?? "v1";
const v1Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1");
const v12Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_2");
const v13Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_3");
const sourceMediaDir = path.join(v1Dir, "source_media");
const inheritedSfxDir = path.join(v12Dir, "sfx_source_downloads");
const localSfxDir = path.join(v13Dir, "sfx_source_downloads");
const sourceAudioDir = path.join(proofInputDir, "source_audio");
const imageDir = path.join(episodeDir, "assets/images");
const workDir = path.join(outputDir, "work_full_v1");
const clipDir = path.join(workDir, "clips");
const graphicDir = path.join(workDir, "graphics");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";

const inputPaths = {
  script: path.join(proofInputDir, "full_script_candidate.md"),
  approval: path.join(proofInputDir, "operator_script_approval.json"),
  narrationManifest: path.join(proofInputDir, "qwen_narration_manifest.json"),
  narrationRun: path.join(proofInputDir, "qwen_narration_run.json"),
  whisperAudit: path.join(proofInputDir, "narration_qwen_adam_whisper_audit.json"),
  narration: path.join(proofInputDir, "narration_qwen_adam_full.wav"),
  originalMusic: path.join(v1Dir, "documentary_underscore.provider-audio"),
  openingBackground: path.join(v12Dir, "opening_motion_assets/red-suitcase-background-plate.png"),
  openingForeground: path.join(v12Dir, "opening_motion_assets/red-suitcase-foreground.png"),
};

const footage = {
  bagPov: media("4NuTfvLPTas.mp4"),
  baggageNetwork: media("_4w9jFDV3Do.mp4"),
  unclaimedStory: media("YiwZ3kbtHj4.mp4"),
  unclaimedNews: media("vZ7Zn70c48w.mp4"),
  backlogNews: media("r2DUoXRlwOk.mp4"),
  sitaTracking: media("WkN7eRmv7E8.mp4"),
  airportBelts: media("wL0wkmah60k.mp4"),
  carouselStock: media("wXZ17FOhY5M.mp4"),
  appBagDrop: media("dDfGMQ_iffA.mp4"),
};

const stills = {
  ownerDesk: image("ep_01-w000009-w000016-modelslab-image.png"),
  darkCarousel: image("ep_01-w000017-w000023-modelslab-image.png"),
  openCase: image("ep_01-w000024-w000038-modelslab-image.png"),
  map: image("ep_01-w000049-w000058-modelslab-image.png"),
  handoff: image("ep_01-w000059-w000076-modelslab-image.png"),
  cleanSuitcase: image("ep_01-w000077-w000087-modelslab-image.png"),
  tag: image("ep_01-w000088-w000095-modelslab-image.png"),
  custodyNetwork: image("ep_01-w000096-w000110-modelslab-image.png"),
  fourNodes: image("ep_01-w000111-w000120-modelslab-image.png"),
  missedConnection: image("ep_01-w000121-w000142-modelslab-image.png"),
  recoveryCurve: image("ep_01-w000143-w000155-modelslab-image.png"),
  lossThreshold: image("ep_01-w000156-w000174-modelslab-image.png"),
  trackingCircle: image("ep_01-w000175-w000189-modelslab-image.png"),
  claimDesk: image("ep_01-w000190-w000201-modelslab-image.png"),
  claimLedger: image("ep_01-w000202-w000210-modelslab-image.png"),
  contentsList: image("ep_01-w000211-w000221-modelslab-image.png"),
  parallelCases: image("ep_01-w000222-w000233-modelslab-image.png"),
  lonelyCarousel: image("ep_01-w000234-w000247-modelslab-image.png"),
  monthRoute: image("ep_01-w000248-w000260-modelslab-image.png"),
  secureWarehouse: image("ep_01-w000261-w000270-modelslab-image.png"),
  longTimeline: image("ep_01-w000271-w000279-modelslab-image.png"),
  intakeHall: image("ep_01-w000280-w000292-modelslab-image.png"),
  identityRemoved: image("ep_01-w000293-w000311-modelslab-image.png"),
  decisionBurst: image("ep_01-w000312-w000331-modelslab-image.png"),
  trailer: image("ep_01-w000332-w000339-modelslab-image.png"),
  receiving: image("ep_01-w000340-w000351-modelslab-image.png"),
  sortingHands: image("ep_01-w000352-w000366-modelslab-image.png"),
  cleanedJacket: image("ep_01-w000367-w000375-modelslab-image.png"),
  electronics: image("ep_01-w000376-w000388-modelslab-image.png"),
  dataWipe: image("ep_01-w000389-w000391-modelslab-image.png"),
  handbag: image("ep_01-w000392-w000395-modelslab-image.png"),
  appraisal: image("ep_01-w000396-w000408-modelslab-image.png"),
  dispositionFork: image("ep_01-w000409-w000415-modelslab-image.png"),
  sellDonate: image("ep_01-w000416-w000430-modelslab-image.png"),
  recycleHall: image("ep_01-w000431-w000437-modelslab-image.png"),
  disposalHall: image("ep_01-w000438-w000448-modelslab-image.png"),
  scaleBurst: image("ep_01-w000449-w000464-modelslab-image.png"),
  decisionTree: image("ep_01-w000465-w000484-modelslab-image.png"),
  openedJourneys: image("ep_01-w000485-w000496-modelslab-image.png"),
  donationBales: image("ep_01-w000497-w000503-modelslab-image.png"),
  secondJourneys: image("ep_01-w000504-w000524-modelslab-image.png"),
  finalLine: image("ep_01-w000525-w000534-modelslab-image.png"),
};

function media(name) {
  return path.join(sourceMediaDir, name);
}

function image(name) {
  return path.join(imageDir, name);
}

function src(paragraph, id, source, start, weight = 1) {
  return { paragraph, kind: "source", id, source, start, weight };
}

function still(paragraph, id, source, weight = 1, direction = 1) {
  return { paragraph, kind: "still", id, source, weight, direction };
}

function graphic(paragraph, id, spec, weight = 1) {
  return { paragraph, kind: "graphic", id, spec, weight };
}

function opening(paragraph, id) {
  return { paragraph, kind: "opening", id, fixed_frames: OPENING_FRAMES, weight: 0 };
}

const timelineBlueprint = [
  opening(0, "v1_parallax_opening"),
  src(0, "carousel_arrival", footage.carouselStock, 0.0, 1.0),
  src(0, "bags_keep_circling", footage.baggageNetwork, 120.0, 1.0),
  still(0, "owner_at_desk", stills.ownerDesk, 0.9, -1),

  graphic(1, "episode_question", {
    type: "question",
    eyebrow: "ASSET AFTERLIFE",
    headline: ["WHERE DOES", "LOST LUGGAGE GO?"],
    footer: "The public journey ends. The hidden one begins.",
  }),

  src(2, "hidden_belt_entry", footage.bagPov, 61.0),
  graphic(2, "hidden_chain", {
    type: "flow",
    eyebrow: "THE HIDDEN RECOVERY CHAIN",
    headline: "ONE BAG. THREE PATHS.",
    nodes: ["BARCODE", "LOCATION", "CLAIM"],
    footer: "The records can separate before the suitcase ever stops moving.",
  }, 1.15),
  src(2, "airport_network_preview", footage.baggageNetwork, 170.0),
  src(2, "alabama_preview", footage.unclaimedStory, 8.0),

  still(3, "representative_red_bag", stills.cleanSuitcase),
  still(3, "united_states_route", stills.map, 1.0, -1),
  graphic(3, "reconstruction_notice", {
    type: "cards",
    eyebrow: "HOW THIS EPISODE WORKS",
    headline: "A DOCUMENTED RECONSTRUCTION",
    cards: ["U.S. RULES", "IATA TRACKING", "PUBLISHED PROCESS"],
    footer: "One representative domestic bag, built from authoritative process evidence.",
  }, 1.1),
  src(3, "unclaimed_exterior", footage.unclaimedStory, 100.0),

  src(4, "airport_scale", footage.baggageNetwork, 10.0),
  graphic(4, "mishandled_total", {
    type: "metric",
    eyebrow: "2024 GLOBAL ESTIMATE",
    value: 33.4,
    decimals: 1,
    suffix: "M",
    headline: "BAGS MISHANDLED",
    footer: "Delayed, damaged, pilfered, or lost.",
  }),
  src(4, "backlog_scale", footage.backlogNews, 1.0),
  graphic(4, "industry_cost", {
    type: "metric",
    eyebrow: "ANNUAL AIRLINE COST",
    prefix: "$",
    value: 5,
    suffix: "B",
    headline: "A SYSTEMIC EXPENSE",
    footer: "The failure rate is small. The starting volume is not.",
  }),
  still(4, "rare_failure_trailer", stills.trailer, 0.9),
  graphic(4, "reunion_rate", {
    type: "split",
    eyebrow: "MOST BAGS GO HOME",
    headline: "RARE DOES NOT MEAN ZERO",
    left: { metric: ">99.5%", label: "REUNITED QUICKLY" },
    right: { metric: "<0.03%", label: "TRULY ORPHANED" },
    footer: "Company-reported rates after an extended search.",
  }, 1.25),

  src(5, "paper_tag_close", footage.baggageNetwork, 120.0),
  src(5, "passenger_handoff", footage.bagPov, 0.0),
  graphic(5, "four_custody_points", {
    type: "flow",
    eyebrow: "IATA RESOLUTION 753",
    headline: "FOUR MINIMUM CUSTODY SCANS",
    nodes: ["HANDOFF", "LOADING", "TRANSFER", "RETURN"],
    footer: "Each scan should close the previous handoff.",
  }, 1.35),
  src(5, "handheld_scan", footage.sitaTracking, 101.0),
  still(5, "custody_audit_trail", stills.custodyNetwork, 0.9, -1),

  src(6, "connection_belt", footage.baggageNetwork, 170.0),
  src(6, "transfer_cart", footage.bagPov, 300.0),
  graphic(6, "transfer_failure", {
    type: "metric",
    eyebrow: "THE VULNERABLE HANDOFF",
    value: 41,
    suffix: "%",
    headline: "HAPPENS DURING TRANSFERS",
    footer: "The passenger can cross the terminal before the bag crosses the airfield.",
  }, 1.25),
  src(6, "high_speed_sort", footage.bagPov, 210.0),
  still(6, "missed_connection", stills.missedConnection, 0.9),

  src(7, "empty_carousel_report", footage.carouselStock, 3.0),
  still(7, "service_desk_report", stills.ownerDesk, 1.0),
  src(7, "tag_receipt", footage.baggageNetwork, 128.0),
  src(7, "tracking_scan", footage.sitaTracking, 190.0),
  src(7, "passenger_app", footage.appBagDrop, 6.2),

  graphic(8, "delayed_not_lost", {
    type: "split",
    eyebrow: "THE FIRST STATUS",
    headline: "DELAYED IS NOT LOST",
    left: { metric: "DELAYED", label: "SEARCH CONTINUES" },
    right: { metric: "LOST", label: "CLAIM BEGINS" },
    footer: "The distinction controls every decision that follows.",
  }, 1.2),
  src(8, "recovery_network", footage.bagPov, 90.0),
  still(8, "recovery_curve", stills.recoveryCurve, 0.9, -1),
  src(8, "bags_at_wrong_airport", footage.backlogNews, 22.0),
  graphic(8, "actual_expenses", {
    type: "cards",
    eyebrow: "DELAY COMPENSATION",
    headline: "REASONABLE. VERIFIABLE. ACTUAL.",
    cards: ["RECEIPT", "NECESSITY", "LIABILITY LIMIT"],
    footer: "Not one invented daily allowance for every passenger.",
  }),

  graphic(9, "twelve_hour_clock", {
    type: "timeline",
    eyebrow: "A SECOND CLOCK STARTS",
    headline: "12 HOURS",
    nodes: ["FLIGHT ARRIVES", "REPORT FILED", "FEE REFUND"],
    footer: "For a significantly delayed domestic checked bag.",
  }, 1.15),
  src(9, "filed_report_app", footage.appBagDrop, 8.5),
  graphic(9, "money_moves_back", {
    type: "split",
    eyebrow: "THE CASE DIVIDES",
    headline: "THE MONEY CAN RETURN FIRST",
    left: { metric: "BAG", label: "STILL MOVING" },
    right: { metric: "FEE", label: "REFUNDED" },
    footer: "A refund does not end the physical search.",
  }),
  src(9, "physical_bag_moves", footage.bagPov, 228.0),
  still(9, "parallel_bag_and_money", stills.parallelCases, 0.9),

  src(10, "days_pass_carousel", footage.carouselStock, 6.0),
  graphic(10, "five_to_fourteen_days", {
    type: "timeline",
    eyebrow: "THE FIRST MAJOR TRANSITION",
    headline: "5–14 DAYS",
    nodes: ["DELAYED", "SEARCHED", "DECLARED LOST"],
    footer: "The exact decision varies by carrier and itinerary.",
  }, 1.25),
  still(10, "lonely_bag", stills.lonelyCarousel),

  still(11, "what_was_inside", stills.openCase),
  still(11, "claim_evidence", stills.claimLedger, 0.95, -1),
  src(11, "claim_desk", footage.backlogNews, 114.0),
  graphic(11, "domestic_liability", {
    type: "metric",
    eyebrow: "U.S. DOMESTIC LIABILITY CEILING",
    prefix: "$",
    value: 4700,
    suffix: "",
    headline: "PER PASSENGER",
    footer: "The airline may pay more. It is not required to.",
  }, 1.25),
  still(11, "claim_closes", stills.claimDesk, 0.85),

  graphic(12, "financial_vs_physical", {
    type: "split",
    eyebrow: "THE HIDDEN GAP",
    headline: "TWO CASES. TWO CLOCKS.",
    left: { metric: "DAYS", label: "FINANCIAL CLAIM" },
    right: { metric: "MONTHS", label: "PHYSICAL RECOVERY" },
    footer: "Paid does not mean abandoned.",
  }, 1.2),
  still(12, "parallel_cases", stills.parallelCases),
  src(12, "recovery_still_active", footage.bagPov, 240.0),
  graphic(12, "three_to_four_months", {
    type: "timeline",
    eyebrow: "THE EXTENDED SEARCH",
    headline: "3–4 MONTHS",
    nodes: ["TRACE", "STORE", "RECHECK", "DISPOSITION"],
    footer: "Published company description of the process before receipt.",
  }, 1.15),

  src(13, "secure_bag_backlog", footage.backlogNews, 4.0),
  still(13, "secure_storage", stills.secureWarehouse),
  graphic(13, "why_keep_searching", {
    type: "cards",
    eyebrow: "WHY THE SEARCH CONTINUES",
    headline: "EVERY BAG IS A LIABILITY",
    cards: ["VALUABLES", "PRIVATE DATA", "DOCUMENTS"],
    footer: "Storage, records, security, and handling continue after payout.",
  }, 1.2),
  src(13, "stacked_property", footage.unclaimedNews, 70.0),
  still(13, "long_recovery_timeline", stills.longTimeline, 0.8, -1),

  src(14, "company_exterior", footage.unclaimedStory, 100.0),
  src(14, "company_store", footage.unclaimedNews, 120.0),
  still(14, "identifying_info_removed", stills.identityRemoved),
  src(14, "retail_preview", footage.unclaimedStory, 10.0),

  still(15, "tractor_trailer_arrival", stills.trailer),
  src(15, "bag_opened", footage.unclaimedStory, 94.0),
  src(15, "contents_sorted", footage.unclaimedStory, 18.0),
  still(15, "one_bag_many_objects", stills.sortingHands, 1.0, -1),
  src(15, "different_destinations", footage.unclaimedStory, 154.0),

  graphic(16, "three_branches", {
    type: "flow",
    eyebrow: "THE BAG STOPS BEING ONE OBJECT",
    headline: "THREE FINAL BRANCHES",
    nodes: ["RESELL", "REPURPOSE", "RECYCLE"],
    footer: "Every item receives its own decision.",
  }, 1.15),
  src(16, "cleaning_process", footage.unclaimedStory, 90.0),
  still(16, "commercial_cleaning", stills.cleanedJacket),
  still(16, "electronics_test", stills.electronics, 0.9, -1),
  src(16, "jewelry_appraisal", footage.unclaimedStory, 216.0),
  still(16, "luxury_authentication", stills.handbag, 0.9),

  src(17, "retail_racks", footage.unclaimedStory, 154.0),
  src(17, "price_and_package", footage.unclaimedStory, 231.0),
  graphic(17, "discount_metric", {
    type: "metric",
    eyebrow: "ADVERTISED DISCOUNTS",
    value: 80,
    suffix: "%",
    headline: "BELOW RETAIL",
    footer: "Up to, depending on item and condition.",
  }),
  src(17, "store_scale", footage.unclaimedNews, 210.0),
  graphic(17, "daily_inventory", {
    type: "metric",
    eyebrow: "UNIQUE STORE ITEMS EACH DAY",
    value: 7000,
    suffix: "+",
    headline: "A TINY RATE AT MASSIVE SCALE",
    footer: "Thousands more are listed online.",
  }, 1.15),

  graphic(18, "ordinary_vs_exceptional", {
    type: "split",
    eyebrow: "MOST CONTENTS ARE ORDINARY",
    headline: "BUT EVERY BAG MUST BE OPENED",
    left: { metric: "MOST", label: "CLOTHES + TOILETRIES" },
    right: { metric: "RARE", label: "UNEXPECTED ARTIFACTS" },
    footer: "Exceptional finds explain why one blanket rule cannot work.",
  }),
  graphic(18, "nasa_camera", {
    type: "artifact",
    eyebrow: "DOCUMENTED RETURN",
    headline: "SPACE SHUTTLE CAMERA",
    artifact: "CAMERA",
    footer: "Identified and returned to NASA.",
  }),
  src(18, "artifact_display", footage.unclaimedStory, 40.0),
  graphic(18, "egyptian_mask", {
    type: "artifact",
    eyebrow: "DOCUMENTED DISCOVERY",
    headline: "EGYPTIAN BURIAL MASK",
    artifact: "MASK",
    footer: "Later handled through Christie's.",
  }),
  graphic(18, "tibetan_horn", {
    type: "artifact",
    eyebrow: "DOCUMENTED DISCOVERY",
    headline: "10-FOOT CEREMONIAL HORN",
    artifact: "HORN",
    footer: "Packed to collapse for travel.",
  }),

  graphic(19, "one_donated_for_one_sold", {
    type: "split",
    eyebrow: "SALE IS ONLY ONE BRANCH",
    headline: "ONE SOLD. ONE DONATED.",
    left: { metric: "1", label: "ITEM SOLD" },
    right: { metric: "1", label: "ITEM DONATED" },
    footer: "Company-reported average.",
  }, 1.2),
  src(19, "clothing_for_reuse", footage.unclaimedNews, 90.0),
  still(19, "donation_bales", stills.donationBales, 0.9),
  src(19, "new_shopper", footage.unclaimedNews, 40.0),

  still(20, "recycling_branch", stills.recycleHall),
  still(20, "disposal_branch", stills.disposalHall, 0.9, -1),
  graphic(20, "identifying_info_shredded", {
    type: "cards",
    eyebrow: "THE FINAL BRANCH",
    headline: "DESTROY OR RECYCLE",
    cards: ["SHRED DATA", "SORT MATERIAL", "REMOVE WASTE"],
    footer: "The afterlife belongs to the contents, not the intact suitcase.",
  }, 1.15),
  still(20, "material_outputs", stills.sellDonate, 0.9),
  still(20, "many_second_journeys", stills.secondJourneys, 0.9, -1),

  graphic(21, "final_tree_scans", {
    type: "flow",
    eyebrow: "THE COMPLETE ANSWER",
    headline: "FIRST: FIND THE ROUTE",
    nodes: ["SCAN", "TRACE", "RECONNECT"],
    footer: "The system tries to send the bag home.",
  }),
  src(21, "scan_again", footage.sitaTracking, 100.0),
  graphic(21, "final_tree_claim", {
    type: "flow",
    eyebrow: "IF THE SEARCH FAILS",
    headline: "THEN: SETTLE THE CLAIM",
    nodes: ["REPORT", "REFUND", "COMPENSATE"],
    footer: "The financial case can end first.",
  }),
  still(21, "decision_tree_visual", stills.decisionTree),
  graphic(21, "final_tree_outcomes", {
    type: "flow",
    eyebrow: "ONLY AFTER EVERY SEARCH",
    headline: "FINALLY: SPLIT THE OBJECT",
    nodes: ["SELL", "DONATE", "RECYCLE"],
    footer: "Separate items. Separate values. Separate endings.",
  }, 1.1),

  still(22, "red_bag_opened", stills.openedJourneys),
  src(22, "items_begin_again", footage.unclaimedStory, 184.0),
  still(22, "second_journeys_final", stills.secondJourneys, 1.0, -1),
  graphic(22, "final_verdict", {
    type: "final",
    eyebrow: "THE SECRET AFTERLIFE OF EXPENSIVE THINGS",
    headline: ["ONE SUITCASE.", "MANY SECOND JOURNEYS."],
    footer: "Its first trip ended. Its contents kept moving.",
  }, 1.25),
];

const sfxSources = {
  baggageMotor: inheritedSfx("JhDvWsWZPvk"),
  carouselAmbience: inheritedSfx("QfQwpUjStt0"),
  conveyorStart: inheritedSfx("biMXVPqOkPw"),
  suitcaseImpact: inheritedSfx("kfNLjFRVmbo"),
  rubberStamp: inheritedSfx("6QcNHrhFEBg"),
  suitcaseWheels: inheritedSfx("JFcFAX-F2M4"),
  suitcaseZipper: inheritedSfx("eH8TB5v8-9A"),
  splitFlap: inheritedSfx("cj32w5z81Ak"),
  ticketScanner: inheritedSfx("jA5rz7T2wks"),
  boardingScanner: localSfx("rTArKNCd5Fc"),
  paperShredder: downloadedAudio("m3CttgyZzhw"),
  retailScanner: downloadedAudio("AGZXC5LhXnY"),
  truckBrake: downloadedAudio("9i2tNw90RbQ"),
  laundry: downloadedAudio("cNaq4ft9gvw"),
  cameraShutter: downloadedAudio("VMUgg4-zp0o"),
};

const sfxCues = [
  cue("opening_baggage_motor", "baggageMotor", 0.0, 0.25, 9.5, 0.045, 0.12, 0.55),
  cue("opening_conveyor_start", "conveyorStart", 0.0, 0.0, 2.48, 0.16, 0.0, 0.28),
  cue("opening_suitcase_settle", "suitcaseImpact", 0.08, 0.0, 1.2, 0.12, 0.0, 0.18),
  cue("opening_status_flap", "splitFlap", 1.72, 0.49, 1.25, 0.16, 0.0, 0.18),
  cue("question_transition", "splitFlap", 14.92, 1.85, 0.72, 0.11, 0.0, 0.12),
  cue("custody_handoff", "boardingScanner", 120.2, 0.226, 0.18, 0.34),
  cue("custody_loading", "boardingScanner", 128.0, 0.226, 0.18, 0.34),
  cue("custody_transfer", "boardingScanner", 136.1, 0.226, 0.18, 0.34),
  cue("custody_return", "boardingScanner", 144.2, 0.226, 0.18, 0.34),
  cue("transfer_scan_missing", "ticketScanner", 177.3, 0.4, 0.24, 0.22),
  cue("report_scan_confirm", "boardingScanner", 205.1, 3.78, 0.36, 0.28),
  cue("delay_status", "splitFlap", 218.7, 2.7, 0.9, 0.11, 0.0, 0.18),
  cue("twelve_hour_clock", "splitFlap", 256.0, 1.5, 1.1, 0.14, 0.0, 0.18),
  cue("refund_confirm", "rubberStamp", 274.0, 7.66, 0.32, 0.12),
  cue("lost_status_stamp", "rubberStamp", 301.0, 7.66, 0.34, 0.17),
  cue("claim_value_stamp", "rubberStamp", 332.0, 7.66, 0.34, 0.14),
  cue("month_route_wheels", "suitcaseWheels", 353.2, 2.5, 2.0, 0.045, 0.0, 0.25),
  cue("truck_arrival", "truckBrake", 430.2, 0.2, 2.6, 0.12, 0.0, 0.3),
  cue("bag_opening_zipper", "suitcaseZipper", 442.1, 0.1, 1.6, 0.18, 0.0, 0.2),
  cue("laundry_process", "laundry", 467.0, 3.0, 6.5, 0.045, 0.2, 0.6),
  cue("electronics_confirm", "boardingScanner", 480.4, 1.27, 0.16, 0.32),
  cue("appraisal_camera", "cameraShutter", 489.4, 3.2, 0.18, 0.12),
  cue("price_scan_one", "retailScanner", 503.2, 0.0, 0.7, 0.12),
  cue("price_scan_two", "retailScanner", 511.2, 0.0, 0.7, 0.1),
  cue("inventory_camera", "cameraShutter", 519.6, 7.0, 0.2, 0.09),
  cue("artifact_camera_one", "cameraShutter", 535.1, 3.2, 0.18, 0.11),
  cue("artifact_camera_two", "cameraShutter", 545.0, 7.0, 0.18, 0.11),
  cue("artifact_camera_three", "cameraShutter", 555.2, 11.0, 0.18, 0.11),
  cue("donation_scan", "retailScanner", 574.0, 0.0, 0.7, 0.1),
  cue("paper_shred", "paperShredder", 595.0, 0.0, 4.2, 0.055, 0.15, 0.45),
  cue("decision_scan", "boardingScanner", 619.0, 0.226, 0.16, 0.24),
  cue("decision_claim", "rubberStamp", 632.0, 7.66, 0.3, 0.1),
  cue("decision_outcome_one", "retailScanner", 641.0, 0.0, 0.7, 0.08),
  cue("decision_outcome_two", "retailScanner", 642.2, 0.0, 0.7, 0.08),
  cue("decision_outcome_three", "retailScanner", 643.4, 0.0, 0.7, 0.08),
  cue("final_wheels", "suitcaseWheels", 653.0, 2.5, 1.7, 0.04, 0.0, 0.25),
];

function inheritedSfx(id) {
  return audioRecord(id, inheritedSfxDir);
}

function localSfx(id) {
  return audioRecord(id, localSfxDir);
}

function downloadedAudio(id) {
  return audioRecord(id, sourceAudioDir);
}

function audioRecord(id, directory) {
  return {
    id,
    path: path.join(directory, `${id}.wav`),
    info_path: path.join(directory, `${id}.info.json`),
  };
}

function cue(id, sourceKey, start, sourceStart, duration, volume, fadeIn = 0, fadeOut = 0) {
  return { id, sourceKey, start, source_start: sourceStart, duration, volume, fade_in: fadeIn, fade_out: fadeOut };
}

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : "true";
    if (parsed[key] !== "true") index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function ensureFile(filePath, expectedHash = null) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1) throw new Error(`Missing input file: ${filePath}`);
  const actualHash = await sha256File(filePath);
  if (expectedHash && expectedHash !== actualHash) throw new Error(`Hash mismatch: ${filePath}`);
  return { path: filePath, size_bytes: stat.size, sha256: actualHash };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function run(command, args, options = {}) {
  const { stdout = "", stderr = "" } = await execFile(command, args, {
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (stderr && flags.verbose === "true") process.stderr.write(stderr);
  return stdout;
}

async function probe(filePath) {
  return JSON.parse(await run(ffprobeBin, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    filePath,
  ]));
}

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(value) {
  const t = clamp(value);
  return 1 - ((1 - t) ** 3);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wordCount(value) {
  return String(value).trim() ? String(value).trim().split(/\s+/u).length : 0;
}

function spokenText(sourceText) {
  const replacements = [
    [/\b2024\b/gu, "twenty twenty-four"],
    [/\b33\.4\b/gu, "thirty-three point four"],
    [/\b99\.5\b/gu, "ninety-nine point five"],
    [/\b0\.03\b/gu, "zero point zero three"],
    [/\b753\b/gu, "seven fifty-three"],
    [/\b41\b/gu, "forty-one"],
    [/\b80\b/gu, "eighty"],
  ];
  return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), sourceText);
}

function sentenceRows(script) {
  const rows = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const paragraphs = script.trim().split(/\n\s*\n/u);
  for (let paragraph = 0; paragraph < paragraphs.length; paragraph += 1) {
    const normalized = paragraphs[paragraph].replace(/\s+/gu, " ").trim();
    for (const sentence of segmenter.segment(normalized)) {
      const text = sentence.segment.trim();
      if (text) rows.push({ paragraph, text, spoken_words: wordCount(spokenText(text)) });
    }
  }
  return { rows, paragraphs };
}

function paragraphDurations(script, narrationManifest, narrationRun) {
  const { rows, paragraphs } = sentenceRows(script);
  const durations = Array(paragraphs.length).fill(0);
  for (let index = 0; index < narrationManifest.units.length; index += 1) {
    const unit = narrationManifest.units[index];
    const runUnit = narrationRun.units[index];
    const scoped = rows.slice(unit.sentence_start_index, unit.sentence_end_index + 1);
    const totalWords = scoped.reduce((sum, row) => sum + row.spoken_words, 0);
    for (const row of scoped) {
      durations[row.paragraph] += Number(runUnit.duration_sec) * (row.spoken_words / totalWords);
    }
    if (index < narrationManifest.units.length - 1) durations[scoped.at(-1).paragraph] += 0.08;
  }
  const narrationDuration = Number(narrationRun.narration_metrics.duration_sec);
  const totalFrames = Math.round(narrationDuration * FPS);
  const paragraphFrames = durations.map((duration) => Math.round(duration * FPS));
  paragraphFrames[paragraphFrames.length - 1] += totalFrames - paragraphFrames.reduce((sum, value) => sum + value, 0);
  return { paragraphs, durations, paragraphFrames, narrationDuration, totalFrames };
}

function allocateFrames(items, paragraphFrames) {
  const scoped = items.map((item) => ({ ...item }));
  const fixed = scoped.reduce((sum, item) => sum + Number(item.fixed_frames ?? 0), 0);
  const flexible = paragraphFrames - fixed;
  if (flexible < 0) throw new Error("Fixed clip frames exceed paragraph duration.");
  const weighted = scoped.filter((item) => !item.fixed_frames);
  const totalWeight = weighted.reduce((sum, item) => sum + Number(item.weight ?? 1), 0);
  let remaining = flexible;
  for (let index = 0; index < weighted.length; index += 1) {
    const item = weighted[index];
    const isLast = index === weighted.length - 1;
    const frames = isLast
      ? remaining
      : Math.max(45, Math.round(flexible * (Number(item.weight ?? 1) / totalWeight)));
    item.frames = frames;
    remaining -= frames;
  }
  if (remaining !== 0 && weighted.length) weighted.at(-1).frames += remaining;
  for (const item of scoped) {
    if (item.fixed_frames) item.frames = Number(item.fixed_frames);
    if (!Number.isInteger(item.frames) || item.frames < 1) throw new Error(`Invalid frame allocation for ${item.id}`);
    item.duration_sec = item.frames / FPS;
  }
  return scoped;
}

function materializeTimeline(timing) {
  const items = [];
  for (let paragraph = 0; paragraph < timing.paragraphFrames.length; paragraph += 1) {
    const blueprint = timelineBlueprint.filter((item) => item.paragraph === paragraph);
    if (!blueprint.length) throw new Error(`No visual blueprint for paragraph ${paragraph + 1}`);
    items.push(...allocateFrames(blueprint, timing.paragraphFrames[paragraph]));
  }
  let frameCursor = 0;
  items.forEach((item, index) => {
    item.index = index;
    item.timeline_start_frame = frameCursor;
    item.timeline_start_sec = frameCursor / FPS;
    frameCursor += item.frames;
    item.timeline_end_frame = frameCursor;
    item.timeline_end_sec = frameCursor / FPS;
    item.output_path = path.join(clipDir, `${String(index + 1).padStart(3, "0")}-${item.id}.mp4`);
  });
  if (frameCursor !== timing.totalFrames) {
    throw new Error(`Timeline frame mismatch: ${frameCursor} vs ${timing.totalFrames}`);
  }
  return items;
}

function suitcaseSvg({ x, y, scale = 1, fill = "#E35732", stroke = "#101923", opacity = 1 }) {
  const width = 112 * scale;
  const height = 142 * scale;
  return `<g opacity="${opacity}">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${18 * scale}" fill="${fill}" stroke="${stroke}" stroke-width="${7 * scale}"/>
    <path d="M ${x + 34 * scale} ${y} v ${-27 * scale} q 0 ${-13 * scale} ${13 * scale} ${-13 * scale} h ${18 * scale} q ${13 * scale} 0 ${13 * scale} ${13 * scale} v ${27 * scale}" fill="none" stroke="${stroke}" stroke-width="${7 * scale}" stroke-linecap="round"/>
    <path d="M ${x + 30 * scale} ${y + 30 * scale} v ${82 * scale} M ${x + 56 * scale} ${y + 30 * scale} v ${82 * scale} M ${x + 82 * scale} ${y + 30 * scale} v ${82 * scale}" stroke="#F8EBDD" stroke-width="${4 * scale}" opacity="0.42"/>
    <circle cx="${x + 25 * scale}" cy="${y + height + 7 * scale}" r="${8 * scale}" fill="${stroke}"/>
    <circle cx="${x + width - 25 * scale}" cy="${y + height + 7 * scale}" r="${8 * scale}" fill="${stroke}"/>
  </g>`;
}

function baseSvg(content, dark = false) {
  const background = dark ? "#101923" : "#F5F0E6";
  const grid = dark ? "#18323B" : "#E6DCCE";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    <path d="M 0 880 H 1920 M 0 930 H 1920" stroke="${grid}" stroke-width="2" opacity="0.55"/>
    <circle cx="1740" cy="90" r="360" fill="${grid}" opacity="0.28"/>
    <g font-family="Avenir Next, Helvetica Neue, sans-serif">${content}</g>
  </svg>`;
}

function artifactIcon(kind, x, y, progress) {
  const opacity = clamp(progress * 3);
  if (kind === "CAMERA") {
    return `<g transform="translate(${x} ${y})" opacity="${opacity}">
      <rect x="0" y="70" width="360" height="230" rx="34" fill="#18323B" stroke="#78B4A8" stroke-width="12"/>
      <rect x="72" y="22" width="126" height="74" rx="18" fill="#E35732"/>
      <circle cx="184" cy="185" r="82" fill="#101923" stroke="#F5F0E6" stroke-width="16"/>
      <circle cx="184" cy="185" r="43" fill="#78B4A8"/>
    </g>`;
  }
  if (kind === "MASK") {
    return `<g transform="translate(${x} ${y})" opacity="${opacity}">
      <path d="M 180 16 L 326 104 L 298 356 L 62 356 L 34 104 Z" fill="#173C4A" stroke="#101923" stroke-width="12"/>
      <path d="M 180 48 L 284 112 L 258 326 L 102 326 L 76 112 Z" fill="#D6A24A" stroke="#101923" stroke-width="10"/>
      <path d="M 48 112 H 312 M 42 166 H 318 M 48 220 H 312" fill="none" stroke="#78B4A8" stroke-width="14"/>
      <path d="M 105 174 Q 136 151 165 174 Q 136 196 105 174 Z M 195 174 Q 224 151 255 174 Q 224 196 195 174 Z" fill="#F5F0E6" stroke="#101923" stroke-width="8"/>
      <circle cx="137" cy="174" r="10" fill="#101923"/><circle cx="223" cy="174" r="10" fill="#101923"/>
      <path d="M 180 188 L 161 258 H 199 Z" fill="#C48737" stroke="#101923" stroke-width="7"/>
      <path d="M 139 284 H 221" fill="none" stroke="#101923" stroke-width="12" stroke-linecap="round"/>
    </g>`;
  }
  return `<g transform="translate(${x} ${y})" opacity="${opacity}">
    <path d="M 28 312 C 176 312 168 54 350 54 C 510 54 472 364 650 364" fill="none" stroke="#E35732" stroke-width="44" stroke-linecap="round"/>
    <circle cx="28" cy="312" r="34" fill="#78B4A8"/><circle cx="650" cy="364" r="34" fill="#78B4A8"/>
  </g>`;
}

function graphicSvg(spec, progress) {
  const p = clamp(progress);
  const enter = easeOutCubic(clamp(p / 0.22));
  const opacity = clamp(p * 4);
  const titleX = 130 - ((1 - enter) * 85);
  const dark = ["question", "final", "artifact"].includes(spec.type);
  const primary = dark ? "#F5F0E6" : "#101923";
  const muted = dark ? "#A6B4B4" : "#667473";
  const eyebrow = `<text x="${titleX}" y="145" fill="#78B4A8" font-size="31" font-weight="800" letter-spacing="6" opacity="${opacity}">${escapeXml(spec.eyebrow ?? "ASSET AFTERLIFE")}</text>`;
  const footer = `<text x="130" y="945" fill="${muted}" font-size="32" font-weight="500" opacity="${opacity}">${escapeXml(spec.footer ?? "")}</text>`;

  if (spec.type === "question" || spec.type === "final") {
    const lines = Array.isArray(spec.headline) ? spec.headline : [spec.headline];
    const finalLayout = spec.type === "final";
    const fontSize = finalLayout ? 98 : 132;
    const text = lines.map((line, index) => `<text x="${titleX}" y="${440 + (index * 155)}" fill="${primary}" font-size="${fontSize}" font-weight="800" letter-spacing="-4" opacity="${opacity}">${escapeXml(line)}</text>`).join("");
    const suitcaseX = (finalLayout ? 1600 : 1500) - ((1 - enter) * 150);
    const suitcaseY = finalLayout ? 430 : 400;
    const suitcaseScale = finalLayout ? 1.82 : 2.25;
    return baseSvg(`${eyebrow}${text}${footer}${suitcaseSvg({ x: suitcaseX, y: suitcaseY, scale: suitcaseScale, stroke: "#F5F0E6", opacity })}`, true);
  }

  if (spec.type === "metric") {
    const animated = Number(spec.value) * easeOutCubic(clamp((p - 0.02) / 0.18));
    const decimals = Number(spec.decimals ?? 0);
    const number = animated.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    const barWidth = 1500 * easeOutCubic(clamp((p - 0.18) / 0.65));
    return baseSvg(`${eyebrow}
      <text x="${titleX}" y="535" fill="#E35732" font-size="230" font-weight="800" letter-spacing="-8" opacity="${opacity}">${escapeXml(spec.prefix ?? "")}${number}${escapeXml(spec.suffix ?? "")}</text>
      <text x="${titleX}" y="685" fill="${primary}" font-size="76" font-weight="800" letter-spacing="-2" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <rect x="130" y="780" width="1500" height="22" rx="11" fill="#D7CDBF"/>
      <rect x="130" y="780" width="${barWidth}" height="22" rx="11" fill="#78B4A8"/>
      ${footer}`);
  }

  if (spec.type === "flow" || spec.type === "timeline") {
    const nodes = spec.nodes ?? [];
    const left = 220;
    const right = 1700;
    const gap = nodes.length > 1 ? (right - left) / (nodes.length - 1) : 0;
    const lineProgress = easeOutCubic(clamp((p - 0.12) / 0.7));
    const nodeRows = nodes.map((label, index) => {
      const x = left + (gap * index);
      const active = clamp((lineProgress * nodes.length) - index);
      return `<circle cx="${x}" cy="640" r="58" fill="${active > 0.15 ? "#E35732" : "#E7DED0"}" stroke="#101923" stroke-width="7"/>
        <text x="${x}" y="652" text-anchor="middle" fill="${active > 0.15 ? "#FFFFFF" : "#101923"}" font-size="34" font-weight="800">${index + 1}</text>
        <text x="${x}" y="755" text-anchor="middle" fill="#101923" font-size="29" font-weight="800" letter-spacing="2" opacity="${opacity}">${escapeXml(label)}</text>`;
    }).join("");
    return baseSvg(`${eyebrow}
      <text x="${titleX}" y="350" fill="${primary}" font-size="88" font-weight="800" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <line x1="${left}" y1="640" x2="${right}" y2="640" stroke="#D7CDBF" stroke-width="18" stroke-linecap="round"/>
      <line x1="${left}" y1="640" x2="${left + ((right - left) * lineProgress)}" y2="640" stroke="#78B4A8" stroke-width="18" stroke-linecap="round"/>
      ${nodeRows}${footer}`);
  }

  if (spec.type === "split") {
    const leftX = 130 - ((1 - enter) * 70);
    const rightX = 1010 + ((1 - enter) * 70);
    return baseSvg(`${eyebrow}
      <text x="${titleX}" y="325" fill="${primary}" font-size="82" font-weight="800" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      <rect x="${leftX}" y="420" width="780" height="340" rx="30" fill="#E8E0D4" stroke="#78B4A8" stroke-width="6"/>
      <rect x="${rightX}" y="420" width="780" height="340" rx="30" fill="#18323B" stroke="#E35732" stroke-width="6"/>
      <text x="${leftX + 390}" y="585" text-anchor="middle" fill="#101923" font-size="105" font-weight="800" opacity="${opacity}">${escapeXml(spec.left.metric)}</text>
      <text x="${leftX + 390}" y="680" text-anchor="middle" fill="#52615F" font-size="31" font-weight="800" letter-spacing="3" opacity="${opacity}">${escapeXml(spec.left.label)}</text>
      <text x="${rightX + 390}" y="585" text-anchor="middle" fill="#FFFFFF" font-size="105" font-weight="800" opacity="${opacity}">${escapeXml(spec.right.metric)}</text>
      <text x="${rightX + 390}" y="680" text-anchor="middle" fill="#A7D2C8" font-size="31" font-weight="800" letter-spacing="3" opacity="${opacity}">${escapeXml(spec.right.label)}</text>
      ${footer}`);
  }

  if (spec.type === "cards") {
    const cards = spec.cards ?? [];
    const rows = cards.map((label, index) => {
      const x = 130 + (index * 555);
      const cardEnter = easeOutCubic(clamp((p * 3) - (index * 0.32)));
      return `<rect x="${x}" y="470" width="490" height="250" rx="28" fill="#18323B" opacity="${0.12 + (0.88 * cardEnter)}"/>
        <circle cx="${x + 72}" cy="545" r="25" fill="#E35732" opacity="${cardEnter}"/>
        <text x="${x + 54}" y="650" fill="#F5F0E6" font-size="35" font-weight="800" letter-spacing="2" opacity="${cardEnter}">${escapeXml(label)}</text>`;
    }).join("");
    return baseSvg(`${eyebrow}
      <text x="${titleX}" y="330" fill="${primary}" font-size="82" font-weight="800" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      ${rows}${footer}`);
  }

  if (spec.type === "artifact") {
    return baseSvg(`${eyebrow}
      <text x="${titleX}" y="365" fill="${primary}" font-size="86" font-weight="800" letter-spacing="-3" opacity="${opacity}">${escapeXml(spec.headline)}</text>
      ${artifactIcon(spec.artifact, 1020, 390, enter)}
      <rect x="130" y="480" width="720" height="8" rx="4" fill="#E35732" opacity="${opacity}"/>
      ${footer}`, true);
  }

  throw new Error(`Unknown graphic type: ${spec.type}`);
}

async function buildStatusCard(outputPath) {
  const svg = `<svg width="560" height="126" viewBox="0 0 560 126" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="558" height="124" rx="10" fill="#091217" fill-opacity="0.92" stroke="#dce6e8" stroke-opacity="0.24" stroke-width="2"/>
    <rect x="1" y="1" width="9" height="124" rx="4" fill="#d84a3f"/>
    <circle cx="40" cy="34" r="6" fill="#d84a3f"/>
    <text x="58" y="42" fill="#b9c8cc" font-family="DIN Condensed, Avenir Next Condensed, sans-serif" font-size="23" font-weight="700" letter-spacing="4">BAGGAGE STATUS</text>
    <text x="30" y="101" fill="#ffffff" font-family="DIN Condensed, Avenir Next Condensed, sans-serif" font-size="48" font-weight="700" letter-spacing="1">NO MATCH YET</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function encodeOpeningClip(item) {
  const statusPath = path.join(workDir, "opening-status-card.png");
  await buildStatusCard(statusPath);
  const duration = item.frames / FPS;
  const filter = [
    `[0:v]scale=${WIDTH}:${HEIGHT}:flags=lanczos,zoompan=z='1.012+0.00024*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},trim=duration=${duration},setpts=PTS-STARTPTS[bg]`,
    `[1:v]scale=1978:1113:flags=lanczos,format=rgba,trim=duration=${duration},setpts=PTS-STARTPTS[fg]`,
    `[bg][fg]overlay=x='-41+12*min(t/${duration},1)':y='-17+if(lt(t,0.18),-20+28*t/0.18,8*exp(-5*(t-0.18))*cos(22*(t-0.18)))':eval=frame:format=auto[scene]`,
    `[2:v]format=rgba,fade=t=in:st=1.72:d=0.12:alpha=1,trim=duration=${duration},setpts=PTS-STARTPTS[card]`,
    `[scene][card]overlay=x='if(lt(t,1.97),${WIDTH}-(${WIDTH}-1280)*(t-1.72)/0.25,1280)':y=120:enable='between(t,1.72,${duration})':eval=frame:format=auto,trim=duration=${duration},fps=${FPS},format=yuv420p[out]`,
  ].join(";");
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-loop", "1", "-framerate", String(FPS), "-t", String(duration), "-i", inputPaths.openingBackground,
    "-loop", "1", "-framerate", String(FPS), "-t", String(duration), "-i", inputPaths.openingForeground,
    "-loop", "1", "-framerate", String(FPS), "-t", String(duration), "-i", statusPath,
    "-filter_complex", filter, "-map", "[out]", "-frames:v", String(item.frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function encodeSourceClip(item) {
  await run(ffmpegBin, [
    "-y", "-v", "error", "-ss", String(item.start ?? 0), "-i", item.source,
    "-frames:v", String(item.frames), "-an",
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},eq=contrast=1.025:saturation=0.97:gamma=0.995`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function encodeStillClip(item) {
  const direction = Number(item.direction ?? 1);
  const zoom = direction > 0
    ? "min(zoom+0.00028,1.075)"
    : "if(eq(on,1),1.075,max(zoom-0.00024,1.0))";
  await run(ffmpegBin, [
    "-y", "-v", "error", "-loop", "1", "-i", item.source,
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},setsar=1`,
    "-frames:v", String(item.frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function encodeGraphicClip(item) {
  const frameDir = path.join(graphicDir, `${String(item.index + 1).padStart(3, "0")}-${item.id}`);
  await fs.mkdir(frameDir, { recursive: true });
  const graphicFrameCount = Math.max(2, Math.ceil(item.duration_sec * GRAPHIC_FPS));
  await mapLimit(Array.from({ length: graphicFrameCount }, (_, index) => index), 8, async (index) => {
    const framePath = path.join(frameDir, `${String(index).padStart(5, "0")}.png`);
    try {
      await ensureFile(framePath);
      return;
    } catch {
      // Missing frame is rendered below.
    }
    const progress = graphicFrameCount <= 1 ? 1 : index / (graphicFrameCount - 1);
    await sharp(Buffer.from(graphicSvg(item.spec, progress))).png().toFile(framePath);
  });
  await run(ffmpegBin, [
    "-y", "-v", "error", "-framerate", String(GRAPHIC_FPS),
    "-i", path.join(frameDir, "%05d.png"),
    "-vf", `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1`,
    "-frames:v", String(item.frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", item.output_path,
  ]);
}

async function clipIsReusable(item) {
  try {
    const details = await probe(item.output_path);
    const duration = Number(details?.format?.duration ?? 0);
    const video = details?.streams?.find((stream) => stream.codec_type === "video");
    return Math.abs(duration - item.duration_sec) <= (2 / FPS)
      && Number(video?.width) === WIDTH
      && Number(video?.height) === HEIGHT;
  } catch {
    return false;
  }
}

async function encodeItem(item) {
  if (await clipIsReusable(item)) return { ...item, reused: true };
  if (item.kind === "opening") await encodeOpeningClip(item);
  else if (item.kind === "source") await encodeSourceClip(item);
  else if (item.kind === "still") await encodeStillClip(item);
  else if (item.kind === "graphic") await encodeGraphicClip(item);
  else throw new Error(`Unknown visual kind: ${item.kind}`);
  await ensureFile(item.output_path);
  return { ...item, reused: false };
}

async function mapLimit(values, concurrency, callback) {
  const results = Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function buildSilentVisual(items, targetDuration, outputPath) {
  const concatPath = path.join(workDir, `timeline-${path.basename(outputPath)}.ffconcat`);
  const body = ["ffconcat version 1.0", ...items.map((item) => `file '${item.output_path.replaceAll("'", "'\\''")}'`)].join("\n");
  await fs.writeFile(concatPath, `${body}\n`, "utf8");
  await run(ffmpegBin, [
    "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
    "-t", String(targetDuration), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", outputPath,
  ]);
  return concatPath;
}

async function buildScoreBed(targetDuration, outputPath) {
  const logistics = path.join(sourceAudioDir, "DnsL1AjOsgQ.wav");
  const innovation = path.join(sourceAudioDir, "FeQobvJ_ABs.wav");
  const filter = [
    "[0:a]atrim=0:180,asetpts=N/SR/TB,loudnorm=I=-24:LRA=8:TP=-2[a0]",
    "[1:a]atrim=0:209,asetpts=N/SR/TB,loudnorm=I=-24:LRA=8:TP=-2[a1]",
    "[2:a]atrim=0:162,asetpts=N/SR/TB,loudnorm=I=-24:LRA=8:TP=-2[a2]",
    "[0:a]atrim=20:154,asetpts=N/SR/TB,loudnorm=I=-24:LRA=8:TP=-2[a3]",
    "[a0][a1]acrossfade=d=2:c1=tri:c2=tri[x1]",
    "[x1][a2]acrossfade=d=2:c1=tri:c2=tri[x2]",
    `[x2][a3]acrossfade=d=2:c1=tri:c2=tri,atrim=0:${targetDuration},afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, targetDuration - 2.5)}:d=2.4[bed]`,
  ].join(";");
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", inputPaths.originalMusic, "-i", logistics, "-i", innovation,
    "-filter_complex", filter, "-map", "[bed]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", outputPath,
  ]);
}

function cueFilter(item, inputIndex, label) {
  const operations = [
    `atrim=start=${item.source_start}:duration=${item.duration}`,
    "asetpts=N/SR/TB",
    "aresample=48000",
    "aformat=sample_rates=48000:channel_layouts=stereo",
    "highpass=f=38",
    "lowpass=f=15500",
    `volume=${item.volume}`,
  ];
  if (item.fade_in) operations.push(`afade=t=in:st=0:d=${item.fade_in}`);
  if (item.fade_out) operations.push(`afade=t=out:st=${Math.max(0, item.duration - item.fade_out)}:d=${item.fade_out}`);
  operations.push(`adelay=${Math.round(item.start * 1000)}:all=1`);
  return `[${inputIndex}:a]${operations.join(",")}[${label}]`;
}

async function mixFinal(silentPath, scorePath, targetDuration, outputPath, cues) {
  const inputs = ["-i", silentPath, "-i", inputPaths.narration, "-i", scorePath];
  for (const item of cues) inputs.push("-i", sfxSources[item.sourceKey].path);
  const filters = [
    `[1:a]highpass=f=58,volume=1.1,apad=pad_dur=1.0,atrim=0:${targetDuration},asetpts=N/SR/TB,aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[voice][voicekey]`,
    `[2:a]atrim=0:${targetDuration},asetpts=N/SR/TB,volume=0.95,aformat=sample_rates=48000:channel_layouts=stereo[bed]`,
    "[bed][voicekey]sidechaincompress=threshold=0.022:ratio=7:attack=12:release=390[ducked]",
  ];
  const labels = ["[voice]", "[ducked]"];
  cues.forEach((item, index) => {
    const label = `fx${index}`;
    filters.push(cueFilter(item, index + 3, label));
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,loudnorm=I=-14.5:LRA=8:TP=-1.5,alimiter=limit=0.84:level=false[mix]`);
  await run(ffmpegBin, [
    "-y", "-v", "error", ...inputs, "-filter_complex", filters.join(";"),
    "-map", "0:v:0", "-map", "[mix]", "-t", String(targetDuration),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", outputPath,
  ]);
}

async function validateInputs() {
  const [script, approval, manifest, narrationRun, whisper] = await Promise.all([
    fs.readFile(inputPaths.script, "utf8"),
    readJson(inputPaths.approval),
    readJson(inputPaths.narrationManifest),
    readJson(inputPaths.narrationRun),
    readJson(inputPaths.whisperAudit),
  ]);
  const scriptHash = await sha256File(inputPaths.script);
  if (approval.status !== "approved" || approval.script_sha256 !== scriptHash) throw new Error("Full proof script approval is stale.");
  if (manifest.script_sha256 !== scriptHash || narrationRun.script_sha256 !== scriptHash) throw new Error("Narration does not match the approved script.");
  const narrationHash = await sha256File(inputPaths.narration);
  if (narrationRun.narration_sha256 !== narrationHash || whisper.audio_sha256 !== narrationHash) throw new Error("Narration or Whisper hash mismatch.");
  if (narrationRun.status !== "passed" || whisper.status !== "passed" || whisper.diagnostic_transcript_status !== "clean") {
    throw new Error("Narration QA is not clean.");
  }
  const required = [
    inputPaths.narration,
    inputPaths.originalMusic,
    inputPaths.openingBackground,
    inputPaths.openingForeground,
    ...Object.values(footage),
    ...Object.values(stills),
    ...Object.values(sfxSources).flatMap((item) => [item.path, item.info_path]),
    path.join(sourceAudioDir, "DnsL1AjOsgQ.wav"),
    path.join(sourceAudioDir, "DnsL1AjOsgQ.info.json"),
    path.join(sourceAudioDir, "FeQobvJ_ABs.wav"),
    path.join(sourceAudioDir, "FeQobvJ_ABs.info.json"),
  ];
  await Promise.all([...new Set(required)].map((filePath) => ensureFile(filePath)));
  return { script, approval, manifest, narrationRun, whisper, scriptHash, narrationHash };
}

async function sourceMetadata(filePath) {
  const value = await readJson(filePath);
  return {
    youtube_id: value.id ?? null,
    youtube_url: value.webpage_url ?? value.original_url ?? null,
    title: value.title ?? null,
    channel: value.channel ?? value.uploader ?? null,
    duration_sec: value.duration ?? null,
  };
}

async function buildSourceLedgers(items, cues) {
  const visualRows = [];
  for (const item of items.filter((entry) => entry.kind === "source")) {
    const infoPath = item.source.replace(/\.mp4$/u, ".info.json");
    visualRows.push({
      cut_id: item.id,
      timeline_start_sec: round(item.timeline_start_sec),
      timeline_end_sec: round(item.timeline_end_sec),
      source_start_sec: item.start,
      source_end_sec: round(item.start + item.duration_sec),
      source_path: item.source,
      source_sha256: await sha256File(item.source),
      source_metadata_path: infoPath,
      source_metadata_sha256: await sha256File(infoPath),
      ...(await sourceMetadata(infoPath)),
    });
  }
  const audioRows = [];
  for (const item of cues) {
    const source = sfxSources[item.sourceKey];
    audioRows.push({
      cue_id: item.id,
      timeline_start_sec: item.start,
      source_start_sec: item.source_start,
      source_end_sec: round(item.source_start + item.duration),
      duration_sec: item.duration,
      gain_scalar: item.volume,
      source_audio_path: source.path,
      source_audio_sha256: await sha256File(source.path),
      source_metadata_path: source.info_path,
      source_metadata_sha256: await sha256File(source.info_path),
      ...(await sourceMetadata(source.info_path)),
    });
  }
  const musicRows = [];
  for (const [id, filePath, infoPath] of [
    ["v1_documentary_underscore", inputPaths.originalMusic, path.join(v1Dir, "documentary_underscore.provider.json")],
    ["logistics_chain", path.join(sourceAudioDir, "DnsL1AjOsgQ.wav"), path.join(sourceAudioDir, "DnsL1AjOsgQ.info.json")],
    ["innovation", path.join(sourceAudioDir, "FeQobvJ_ABs.wav"), path.join(sourceAudioDir, "FeQobvJ_ABs.info.json")],
  ]) {
    musicRows.push({
      id,
      path: filePath,
      sha256: await sha256File(filePath),
      metadata_path: infoPath,
      metadata_sha256: await sha256File(infoPath),
      metadata: id === "v1_documentary_underscore" ? await readJson(infoPath) : await sourceMetadata(infoPath),
    });
  }
  const visualPath = path.join(outputDir, "full_proof_visual_source_ledger.json");
  const audioPath = path.join(outputDir, "full_proof_audio_source_ledger.json");
  await writeJson(visualPath, {
    schema: "goldflow_private_full_proof_visual_source_ledger_v1",
    status: "passed",
    proof_only: true,
    rights_review_deferred_by_operator: true,
    rows: visualRows,
  });
  await writeJson(audioPath, {
    schema: "goldflow_private_full_proof_audio_source_ledger_v1",
    status: "passed",
    proof_only: true,
    rights_review_deferred_by_operator: true,
    generated_sfx_used: false,
    sfx_cues: audioRows,
    music_sources: musicRows,
  });
  return { visualPath, audioPath, visualRows, audioRows, musicRows };
}

async function buildContactSheet(videoPath, outputPath, intervalSec = 20) {
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", videoPath,
    "-vf", `fps=1/${intervalSec},scale=320:180,tile=6x6:padding=4:margin=4:color=0x0d171c`,
    "-frames:v", "1", outputPath,
  ]);
}

async function main() {
  const finalPath = path.join(outputDir, `lost_luggage_full_hybrid_proof_adam_qwen_${proofVersion}.mp4`);
  const previewSec = flags["preview-sec"] ? Number(flags["preview-sec"]) : null;
  if (!previewSec) {
    try {
      await fs.access(finalPath);
      throw new Error(`Append-only full proof already exists: ${finalPath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const inputs = await validateInputs();
  await fs.mkdir(clipDir, { recursive: true });
  await fs.mkdir(graphicDir, { recursive: true });
  const timing = paragraphDurations(inputs.script, inputs.manifest, inputs.narrationRun);
  const timeline = materializeTimeline(timing);
  const targetDuration = previewSec ? Math.min(previewSec, timing.narrationDuration) : timing.narrationDuration;
  const selected = timeline.filter((item) => item.timeline_start_sec < targetDuration);
  const encoded = await mapLimit(selected, Number(flags.concurrency ?? 4), encodeItem);
  const silentPath = path.join(workDir, previewSec ? `silent-preview-${targetDuration}.mp4` : "silent-full.mp4");
  const scorePath = path.join(workDir, previewSec ? `score-preview-${targetDuration}.wav` : "score-full.wav");
  const outputPath = previewSec ? path.join(outputDir, `full_proof_preview_${Math.round(targetDuration)}s.mp4`) : finalPath;
  await buildSilentVisual(encoded, targetDuration, silentPath);
  await buildScoreBed(targetDuration, scorePath);
  const scopedCues = sfxCues.filter((item) => item.start < targetDuration);
  await mixFinal(silentPath, scorePath, targetDuration, outputPath, scopedCues);

  const outputProbe = await probe(outputPath);
  if (previewSec) {
    process.stdout.write(`${JSON.stringify({
      status: "preview_rendered",
      output_path: outputPath,
      duration_sec: Number(outputProbe?.format?.duration ?? 0),
      encoded_cut_count: encoded.length,
      cached_cut_count: encoded.filter((item) => item.reused).length,
    }, null, 2)}\n`);
    return;
  }

  const openingPreviewPath = path.join(outputDir, "full_proof_opening_60s.mp4");
  await run(ffmpegBin, ["-y", "-v", "error", "-i", finalPath, "-t", "60", "-c", "copy", "-movflags", "+faststart", openingPreviewPath]);
  const contactSheetPath = path.join(outputDir, "full_proof_contact_sheet_20s.jpg");
  await buildContactSheet(finalPath, contactSheetPath, 20);
  const ledgers = await buildSourceLedgers(timeline, sfxCues);
  const kindDuration = Object.fromEntries(["opening", "source", "graphic", "still"].map((kind) => [
    kind,
    round(timeline.filter((item) => item.kind === kind).reduce((sum, item) => sum + item.duration_sec, 0)),
  ]));
  const report = {
    schema: "goldflow_asset_afterlife_full_hybrid_proof_v1",
    status: "rendered_pending_final_qa",
    proof_only: true,
    official_pipeline_artifacts_modified: false,
    created_at: new Date().toISOString(),
    output_dir: outputDir,
    input_proof_dir: proofInputDir,
    lineage: {
      proof_version: proofVersion,
      canonical_pacing_baseline: "hybrid_documentary_parity_proof_v1",
      opening_motion_lineage: "hybrid_documentary_parity_proof_v1_2",
      sourced_sfx_lineage: "hybrid_documentary_parity_proof_v1_3",
      prior_proofs_modified: false,
    },
    script: {
      path: inputPaths.script,
      sha256: inputs.scriptHash,
      word_count: wordCount(inputs.script),
      approval_path: inputPaths.approval,
      approval_sha256: await sha256File(inputPaths.approval),
    },
    narration: {
      path: inputPaths.narration,
      sha256: inputs.narrationHash,
      duration_sec: timing.narrationDuration,
      qwen_report_path: inputPaths.narrationRun,
      whisper_audit_path: inputPaths.whisperAudit,
      word_error_rate: inputs.whisper.word_error_rate,
      post_tts_tempo_processing: false,
    },
    edit: {
      total_cut_count: timeline.length,
      average_cut_duration_sec: round(timing.narrationDuration / timeline.length),
      kind_duration_sec: kindDuration,
      real_footage_share: round(kindDuration.source / timing.narrationDuration, 4),
      graphics_share: round(kindDuration.graphic / timing.narrationDuration, 4),
      moving_still_share: round(kindDuration.still / timing.narrationDuration, 4),
      opening_parallax_share: round(kindDuration.opening / timing.narrationDuration, 4),
      cut_cache_reuse_count: encoded.filter((item) => item.reused).length,
      timeline: timeline.map((item) => ({
        index: item.index,
        paragraph: item.paragraph + 1,
        id: item.id,
        kind: item.kind,
        timeline_start_sec: round(item.timeline_start_sec),
        timeline_end_sec: round(item.timeline_end_sec),
        duration_sec: round(item.duration_sec),
        frames: item.frames,
        output_path: item.output_path,
      })),
    },
    audio_design: {
      score_sections: 4,
      crossfade_count: 3,
      sourced_sfx_cue_count: sfxCues.length,
      generated_sfx_used: false,
      target_lufs: -14.5,
      target_true_peak_dbtp: -1.5,
      visual_source_ledger_path: ledgers.visualPath,
      audio_source_ledger_path: ledgers.audioPath,
    },
    output: {
      video_path: finalPath,
      video_sha256: await sha256File(finalPath),
      duration_sec: Number(outputProbe?.format?.duration ?? 0),
      size_bytes: Number(outputProbe?.format?.size ?? 0),
      probe: outputProbe,
      opening_preview_path: openingPreviewPath,
      opening_preview_sha256: await sha256File(openingPreviewPath),
      contact_sheet_path: contactSheetPath,
      contact_sheet_sha256: await sha256File(contactSheetPath),
    },
  };
  const reportPath = path.join(outputDir, `full_hybrid_proof_${proofVersion}_report.json`);
  await writeJson(reportPath, report);
  const recipeDir = path.join(outputDir, "recipe_snapshot");
  await fs.mkdir(recipeDir, { recursive: true });
  await fs.copyFile(currentFile, path.join(recipeDir, path.basename(currentFile)));
  await fs.copyFile(path.join(repoRoot, "scripts/proofs/lock-proof-baseline.mjs"), path.join(recipeDir, "lock-proof-baseline.mjs"));
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    video_path: finalPath,
    video_sha256: report.output.video_sha256,
    duration_sec: report.output.duration_sec,
    cut_count: report.edit.total_cut_count,
    real_footage_share: report.edit.real_footage_share,
    graphics_share: report.edit.graphics_share,
    report_path: reportPath,
    opening_preview_path: openingPreviewPath,
    contact_sheet_path: contactSheetPath,
  }, null, 2)}\n`);
}

await main();
