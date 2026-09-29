import test from "node:test";
import assert from "node:assert/strict";
import { chooseNativeValidationRows } from "../lib/fal-validation-selector.mjs";

const human = id => ({ref_id:id,kind:"character_state",identity_subtype:"human"});
const base = (id,time,extra={}) => ({
  image_id:`ep_01-${id}`,scene_id:`scene_${id}`,start_sec:time,
  image_generation_required:true,reference_requirements:[human(`${id}_person`)],
  sequence_grammar:{shot_size:"medium"},shot_manifest:{shot_job:"interaction",visible_characters:[id]},
  ...extra,
});

test("eight-shot validation covers different image risks across one episode", () => {
  const rows=[
    base("opening",0),
    base("ignored_text_only",5,{reference_requirements:[]}),
    base("paired",15,{reference_requirements:[human("a"),human("b")]}),
    base("dense",28,{reference_requirements:[human("c"),human("d"),human("e")]}),
    base("object",40,{sequence_grammar:{shot_size:"close insert"},reference_requirements:[human("f"),{ref_id:"tool",kind:"prop"}]}),
    base("machine",52,{reference_requirements:[human("g"),{ref_id:"service_machine",kind:"character_state",identity_subtype:"robot"}]}),
    base("setting",64,{sequence_grammar:{shot_size:"wide"},reference_requirements:[{ref_id:"campus",kind:"location"}]}),
    base("contact",78,{shot_manifest:{shot_job:"physical_action",anatomy_contracts:[{visibility_required:true}]}}),
    base("aftermath",94,{active_state_constraints:{entities:{hero:{wardrobe:"clean coat"}}}}),
    base("ignored_no_image",99,{image_generation_required:false}),
  ];
  const selected=chooseNativeValidationRows(rows);
  assert.deepEqual(selected.map(item=>item.category),[
    "opening_identity","paired_human_identity","dense_cast","close_object_or_hand",
    "nonhuman_or_device","wide_environment","physical_contact","late_character_state",
  ]);
  assert.deepEqual(selected.map(item=>item.row.image_id),[
    "ep_01-opening","ep_01-paired","ep_01-dense","ep_01-object",
    "ep_01-machine","ep_01-setting","ep_01-contact","ep_01-aftermath",
  ]);
  assert(selected.every(item=>item.category_matched));
  assert.deepEqual(chooseNativeValidationRows([...rows].reverse()).map(item=>item.row.image_id),selected.map(item=>item.row.image_id));
});

test("unavailable category is marked as a fallback without duplicating shots", () => {
  const rows=Array.from({length:10},(_,index)=>base(`plain_${index}`,index*10));
  const selected=chooseNativeValidationRows(rows);
  assert.equal(selected.length,8);
  assert.equal(new Set(selected.map(item=>item.row.image_id)).size,8);
  assert(selected.some(item=>item.category_matched===false));
  assert.equal(selected[0].row.image_id,"ep_01-plain_0");
});

test("collage validation requires eight reference-backed production shots", () => {
  const rows=Array.from({length:8},(_,index)=>base(`shot_${index}`,index));
  rows[7].reference_requirements=[];
  assert.throws(()=>chooseNativeValidationRows(rows),/eight distinct reference-backed/);
});
