"""Align two independently QA-passed takes of the same locked script.

This maps picture time only. It never processes or changes audio samples.
"""
import difflib
import json
import re
import sys

old, new = [json.load(open(p)) for p in sys.argv[1:3]]
assert old['source_script_hash'] == new['source_script_hash'], 'Different source scripts'
norm = lambda row: re.sub(r'[^a-z0-9]', '', row['word'].lower())
a, b = old['words'], new['words']
matcher = difflib.SequenceMatcher(None, list(map(norm, a)), list(map(norm, b)), autojunk=False)
assert matcher.ratio() >= .98, 'Insufficient exact timing anchors'
anchors = [[0, 0]]
differences = []
for op, i, j, k, l in matcher.get_opcodes():
    if op != 'equal':
        assert max(j-i, l-k) <= 3, 'Unanchored span exceeds three words'
        differences.append(dict(operation=op, old_span=[i,j], new_span=[k,l]))
        continue
    for x, y in zip(range(i,j), range(k,l)):
        point = [a[x]['start_sec'], b[y]['start_sec']]
        if point[0] > anchors[-1][0] and point[1] > anchors[-1][1]:
            anchors.append(point)
end = [old['audio_duration_sec'], new['audio_duration_sec']]
assert end[0] > anchors[-1][0] and end[1] > anchors[-1][1]
anchors.append(end)
print(json.dumps(dict(schema='goldflow_same_script_word_anchor_map_v1', anchors=anchors,
    exact_match_ratio=matcher.ratio(), differences=differences,
    audio_samples_modified=False, source_script_hash=old['source_script_hash'])))
