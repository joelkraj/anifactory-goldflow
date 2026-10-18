#!/usr/bin/env python3
"""One reserved, raw-only batch-four comparison. Invoked by the guarded wrapper."""
import argparse
import hashlib
import importlib.metadata
import json
import time
from pathlib import Path


def digest(file):
    with Path(file).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def write_new(file, value):
    with Path(file).open('x', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text())
    output = manifest_path.parent
    marker = json.loads((output / 'attempt_started.json').read_text())
    if marker['manifest_sha256'] != digest(manifest_path) or marker['attempts_authorized'] != 1:
        raise ValueError('Missing exact one-attempt authorization')
    if manifest['schema'] != 'goldflow_qwen_submission_diagnostic_v1' or Path(manifest['output_dir']).resolve() != output:
        raise ValueError('Invalid bounded diagnostic manifest')
    if sorted(item.name for item in output.iterdir()) != ['attempt_started.json', 'manifest.json']:
        raise ValueError('Existing diagnostic outputs retained; no overwrite or resume')
    for bindings in [manifest['source_hashes'], manifest['code_hashes'], manifest['environment']['bindings']]:
        for file, expected in bindings.items():
            if digest(file) != expected:
                raise ValueError(f'Stale bound file: {file}')
    if importlib.metadata.version('mlx-audio') != manifest['environment']['runtime']['mlx_audio']:
        raise ValueError('Runtime drift')
    # All checks and the attempt marker precede the first MLX/model import/load.
    import mlx.core as mx
    import numpy as np
    from mlx_audio.audio_io import write as audio_write
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import load_audio

    report = {'schema': 'goldflow_qwen_submission_diagnostic_raw_report_v1', 'status': 'started', 'manifest_sha256': digest(manifest_path), 'listening_performed': False, 'variants': [], 'model_load_count': 0}
    events = output / 'submission_events.jsonl'

    def event(value):
        with events.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(value) + '\n')

    try:
        started = time.perf_counter()
        event({'event': 'model_load_started', 'time': time.time()})
        model = load_model(manifest['model']['id'], revision=manifest['model']['revision'], local_files_only=True)
        mx.eval(model.parameters())
        report['model_load_count'] = 1
        report['model_load_sec'] = time.perf_counter() - started
        reference = manifest['reference']
        audio = load_audio(reference['path'], sample_rate=int(model.sample_rate))
        mx.eval(audio)
        settings = manifest['execution']
        for variant in manifest['variants']:
            directory = output / variant['id']
            directory.mkdir()
            arm = {'id': variant['id'], 'results': [], 'cohorts': [], 'audio_duration_sec': 0}
            report['variants'].append(arm)
            units = variant['units']
            for cohort in variant['batch_plan']['cohorts']:
                indexes = [member['original_order_index'] for member in cohort['members']]
                seed = cohort['batch_seed']
                arm['cohorts'].append(cohort)
                event({'event': 'cohort_submitted', 'arm': variant['id'], **cohort, 'payloads': [units[i]['text'] for i in indexes]})
                mx.random.seed(seed)
                generated = list(model.batch_generate(texts=[units[i]['text'] for i in indexes], voices=[None] * len(indexes), instructs=[None] * len(indexes), ref_audio=audio, ref_text=reference['text'], temperature=settings['temperature'], top_p=settings['top_p'], top_k=settings['top_k'], repetition_penalty=settings['repetition_penalty'], max_tokens=settings['max_tokens'], verbose=False, stream=False))
                sequences = [int(item.sequence_idx) for item in generated]
                if sorted(sequences) != list(range(len(indexes))):
                    raise RuntimeError('Missing, duplicate or unknown batch sequence')
                for item in generated:
                    source_index = indexes[int(item.sequence_idx)]
                    unit = units[source_index]
                    mx.eval(item.audio)
                    samples = np.asarray(item.audio, dtype=np.float32).reshape(-1)
                    if int(item.sample_rate) != 24000 or not len(samples) or not np.isfinite(samples).all():
                        raise RuntimeError('Invalid native raw samples/rate; no acceptance')
                    audio_path = directory / f'{source_index + 1:03d}_{unit["id"]}.wav'
                    with audio_path.open('xb'):
                        pass
                    audio_write(str(audio_path), samples, int(item.sample_rate), format='wav')
                    row = {**unit, 'source_order_index': source_index, 'spoken_text_sha256': hashlib.sha256(unit['text'].encode()).hexdigest(), 'output_path': str(audio_path), 'output_sha256': digest(audio_path), 'sample_rate_hz': int(item.sample_rate), 'sample_count': len(samples), 'duration_sec': len(samples) / int(item.sample_rate), 'token_count': int(item.token_count), 'token_limit_reached': int(item.token_count) >= settings['max_tokens'], 'cohort': cohort}
                    write_new(audio_path.with_suffix('.json'), row)
                    arm['results'].append(row)
                    arm['audio_duration_sec'] += row['duration_sec']
                    event({'event': 'unit_retained', 'arm': variant['id'], 'unit_id': unit['id'], 'output_sha256': row['output_sha256']})
                if any(row['token_limit_reached'] for row in arm['results']):
                    raise RuntimeError('Token-limited output retained but diagnostic rejected')
                if arm['audio_duration_sec'] > settings['max_audio_sec_per_arm']:
                    raise RuntimeError('Actual audio exceeded 120-second arm bound; retained without trimming, no further submissions')
            arm['results'].sort(key=lambda row: row['source_order_index'])
            if [row['id'] for row in arm['results']] != [unit['id'] for unit in units]:
                raise RuntimeError('Output source order mismatch')
        report['status'] = 'passed'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        write_new(output / 'raw_generation_report.json', report)


if __name__ == '__main__':
    main()
