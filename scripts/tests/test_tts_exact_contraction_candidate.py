"""Guard the one source-bound, non-listening contraction candidate."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "tts-exact-contraction-candidate.py"
spec = importlib.util.spec_from_file_location("tts_exact_contraction_candidate", SCRIPT)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class ExactContractionCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.episode = Path(self.temp.name) / "ep_01"
        self.episode.mkdir()
        self.unit_id = "narr_voice_seg_84_u001-002_3193dd7890af"
        self.contract = candidate.runner.QWEN_JOEL_DRY_DEADPAN_REFERENCE
        self.remainder_wav = self.episode / "retained-remainder.wav"
        self.remainder_wav.write_bytes(b"retained PCM fixture")
        self.remainder_sidecar = self.episode / "retained-remainder.json"
        self.sidecar = {
            "schema": "goldflow_tts_exact_boundary_fragment_v1",
            "fragment_index": 1,
            "unit_id": self.unit_id,
            "text": candidate.REMAINDER_TEXT,
            "text_sha256": candidate.digest(candidate.REMAINDER_TEXT.encode()),
            "audio_path": str(self.remainder_wav),
            "audio_sha256": candidate.file_digest(self.remainder_wav),
            "model_id": candidate.runner.QWEN["model_id"],
            "model_revision": candidate.runner.QWEN["revision"],
            "voice_id": self.contract["voice_id"],
            "voice_sha256": self.contract["voice_sha256"],
            "reference_audio_sha256": self.contract["audio_sha256"],
        }
        self.remainder_sidecar.write_text(json.dumps(self.sidecar))
        self.base = {
            "schema": candidate.REQUEST_SCHEMA,
            "episode_dir": str(self.episode),
            "unit_id": self.unit_id,
            "spoken_text_sha256": candidate.digest(
                f"{candidate.SOURCE_FIRST} {candidate.REMAINDER_TEXT}".encode()),
            "expected_first_fragment": candidate.SOURCE_FIRST,
            "tts_only_first_fragment": candidate.TTS_FIRST,
            "remainder_text": candidate.REMAINDER_TEXT,
            "retained_remainder": {
                "audio_path": str(self.remainder_wav),
                "audio_sha256": candidate.file_digest(self.remainder_wav),
                "sidecar_path": str(self.remainder_sidecar),
                "sidecar_sha256": candidate.file_digest(self.remainder_sidecar),
            },
            "recovery_authorization": {
                "authorization_origin": "user_authorized_autonomous_production",
                "human_listening_performed": False,
            },
            "model_id": candidate.runner.QWEN["model_id"],
            "model_revision": candidate.runner.QWEN["revision"],
            "voice_id": self.contract["voice_id"],
            "voice_sha256": self.contract["voice_sha256"],
            "voice_continuity_contract": self.contract["voice_continuity_contract"],
        }

    def validate(self, changes=None, rehash=True):
        request = {**self.base, **(changes or {})}
        canonical = json.dumps(request, sort_keys=True, ensure_ascii=False,
                               separators=(",", ":")).encode()
        request["request_sha256"] = candidate.digest(canonical) if rehash else "0" * 64
        output_dir = self.episode / "contraction_candidates" / request["request_sha256"]
        request_path = output_dir / "request.json"
        with patch.object(candidate.runner, "validate_file"), \
                patch.object(candidate.runner, "package_version",
                             return_value=candidate.runner.MLX_AUDIO_VERSION):
            return candidate.validate_request(request, request_path, output_dir)

    def test_accepts_only_the_exact_past_perfect_expansion(self):
        contract, remainder, retained_path = self.validate()
        self.assertEqual(contract["audio_sha256"], self.contract["audio_sha256"])
        self.assertEqual(remainder["audio_sha256"], candidate.file_digest(self.remainder_wav))
        self.assertEqual(retained_path, self.remainder_wav)
        for change in (
            {"expected_first_fragment": "She looked at me"},
            {"tts_only_first_fragment": "She looked at me"},
            {"tts_only_first_fragment": "She had seen me"},
            {"remainder_text": "at me in the mirror. She knew where she was going."},
            {"spoken_text_sha256": "0" * 64},
            {"recovery_authorization": {"authorization_origin":
                "user_authorized_autonomous_production", "human_listening_performed": True}},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.validate(change)
        with self.assertRaisesRegex(ValueError, "request hash mismatch"):
            self.validate(rehash=False)

    def test_rejects_stale_or_unrelated_retained_fragment(self):
        bad = {**self.sidecar, "text": "a different sentence"}
        self.remainder_sidecar.write_text(json.dumps(bad))
        retained = {**self.base["retained_remainder"],
                    "sidecar_sha256": candidate.file_digest(self.remainder_sidecar)}
        with self.assertRaisesRegex(ValueError, "locked second fragment"):
            self.validate({"retained_remainder": retained})
        self.remainder_sidecar.write_text(json.dumps(self.sidecar))
        with self.assertRaisesRegex(ValueError, "remainder changed"):
            self.validate({"retained_remainder": {
                **self.base["retained_remainder"], "audio_sha256": "0" * 64}})

    def test_composite_gap_is_exactly_eighty_milliseconds_and_files_are_immutable(self):
        first = candidate.wav_payload(b"\x01\x00" * 3)
        second = candidate.wav_payload(b"\x02\x00" * 2)
        first_path = self.episode / "first.wav"
        second_path = self.episode / "second.wav"
        first_path.write_bytes(first)
        second_path.write_bytes(second)
        composite = candidate.wav_samples(first_path) \
            + bytes(candidate.GAP_SAMPLES * 2) + candidate.wav_samples(second_path)
        output = self.episode / "composite.wav"
        candidate.write_new(output, candidate.wav_payload(composite))
        self.assertEqual(len(candidate.wav_samples(output)) // 2, 3 + 1920 + 2)
        candidate.write_new(output, candidate.wav_payload(composite))
        with self.assertRaisesRegex(ValueError, "Immutable contraction artifact"):
            candidate.write_new(output, candidate.wav_payload(b"\x03\x00"))


if __name__ == "__main__":
    unittest.main()
