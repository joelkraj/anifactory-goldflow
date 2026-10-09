import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createRecapSourcePackage, loadRecapSourcePackage, indexRecapText } from '../lib/recap-source-package.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'goldflow-recap-source-'));
let count = 0;
async function test(name, work) { await work(); count += 1; console.log(`ok - recap source: ${name}`); }
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
let sequence = 0;
async function makeConfig(overrides = {}) {
  const config = { schema: 'goldflow_recap_source_config_v1', id: 'source-fixture', title: 'Original chapter fixture', source_kind: 'prose', files: [{ id: 'chapter-2', path: 'second.md' }, { id: 'chapter-1', path: 'first.txt' }], ...overrides };
  const configPath = path.join(scratch, `config-${++sequence}.json`);
  await writeJson(configPath, config);
  return { config, configPath, outputDir: path.join(scratch, `package-${sequence}`) };
}

try {
  const first = '\uFEFFFirst exact sentence. A café remained open.\r\n\r\n  He paid $5.00.\r\nAnd left.  \r\n';
  const second = '# Chapter Two\n\nA second chapter began. 🗝️ It kept its own punctuation!\n\n<script>alert("source")</script>\n';
  await fs.writeFile(path.join(scratch, 'first.txt'), first);
  await fs.writeFile(path.join(scratch, 'second.md'), second);
  await sharp({ create: { width: 120, height: 360, channels: 3, background: '#f5dcba' } }).png().toFile(path.join(scratch, 'page-2.png'));
  await sharp({ create: { width: 200, height: 300, channels: 3, background: '#385366' } }).webp().toFile(path.join(scratch, 'page-1.webp'));

  await test('exact prose snapshots, explicit chapter order and source spans survive indexing', async () => {
    const args = await makeConfig();
    const result = await createRecapSourcePackage(args);
    const loaded = await loadRecapSourcePackage(result.package_path);
    assert.deepEqual(loaded.package.files.map(file => file.id), ['chapter-2', 'chapter-1']);
    assert.deepEqual(await fs.readFile(path.join(args.outputDir, 'sources/chapter-1.txt')), Buffer.from(first));
    assert.deepEqual(await fs.readFile(path.join(args.outputDir, 'sources/chapter-2.md')), Buffer.from(second));
    for (const ref of [...loaded.text_index.paragraphs, ...loaded.text_index.sentences]) {
      const source = ref.file_id === 'chapter-1' ? first : second;
      assert.equal(source.slice(ref.start_char, ref.end_char), ref.text);
      assert.equal(ref.sha256, hash(ref.text));
    }
    assert.equal(loaded.panel_inventory.status, 'not_applicable');
    assert.equal(loaded.package.production_eligible, false);
    const template = JSON.parse(await fs.readFile(result.template_path, 'utf8'));
    assert.equal(template.source_package_sha256, hash(await fs.readFile(result.package_path)));
    assert.deepEqual(template.draft_units, []);
    const report = JSON.parse(await fs.readFile(result.report_path, 'utf8'));
    assert.equal(report.provider_calls, 0); assert.equal(report.accepted_panel_count, 0);
    const html = await fs.readFile(result.review_path, 'utf8');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
    await assert.rejects(createRecapSourcePackage(args), /already exists/);
  });

  await test('comic order and exact authored crops remain advisory and whole pages never become accepted panels', async () => {
    const args = await makeConfig({ source_kind: 'comic', files: [{ id: 'page-b', path: 'page-2.png' }, { id: 'page-a', path: 'page-1.webp' }], panels: [{ id: 'upper', file_id: 'page-b', source_rect: { x: 0, y: 0, width: 1, height: 0.4 }, metadata: { note: 'Manual candidate crop' } }, { id: 'lower', file_id: 'page-b', source_rect: { x: 0, y: 0.5, width: 1, height: 0.5 } }] });
    const loaded = await loadRecapSourcePackage((await createRecapSourcePackage(args)).package_path);
    assert.deepEqual(loaded.package.files.map(file => file.id), ['page-b', 'page-a']);
    assert.deepEqual(loaded.panel_inventory.panels.map(panel => panel.id), ['upper', 'lower', 'page-a-whole-page']);
    assert.deepEqual(loaded.panel_inventory.panels[1].source_rect, args.config.panels[1].source_rect);
    assert.ok(loaded.panel_inventory.panels.every(panel => panel.review_status === 'needs_review'));
    assert.equal(loaded.panel_inventory.panels[2].method, 'whole_page_proposal');
    assert.deepEqual(loaded.text_index.paragraphs, []);
    assert.equal(loaded.adaptation_packet.draft_unit_shape.source_refs[0].quote, undefined);
    assert.equal(loaded.package.files[0].height, 360);
  });

  await test('original-script mode preserves exact approved-candidate text with no creative rewriting', async () => {
    const args = await makeConfig({ source_kind: 'original_script', files: [{ id: 'script', path: 'first.txt', sha256: hash(first) }] });
    const result = await createRecapSourcePackage(args);
    assert.equal(await fs.readFile(path.join(args.outputDir, 'sources/script.txt'), 'utf8'), first);
    assert.equal(result.package.source_kind, 'original_script');
  });

  await test('stale expected sources, duplicate IDs/paths and invalid crops reject before output creation', async () => {
    const cases = [
      [{ files: [{ id: 'chapter', path: 'first.txt', sha256: 'a'.repeat(64) }] }, /stale source/],
      [{ files: [{ id: 'repeat', path: 'first.txt' }, { id: 'repeat', path: 'second.md' }] }, /duplicate file id/],
      [{ files: [{ id: '../escape', path: 'first.txt' }] }, /invalid/],
      [{ files: [{ id: 'same1', path: 'first.txt' }, { id: 'same2', path: 'first.txt' }] }, /duplicate source path/],
      [{ files: [{ id: 'remote', path: 'https://example.test/chapter.txt' }] }, /local path/],
      [{ source_kind: 'comic', files: [{ id: 'page', path: 'page-2.png' }], panels: [{ id: 'crop', file_id: 'page', source_rect: { x: 0.8, y: 0, width: 0.4, height: 1 } }] }, /crop/],
      [{ source_kind: 'comic', files: [{ id: 'page', path: 'page-2.png' }], panels: [{ id: 'crop', file_id: 'page', source_rect: { x: 0, y: 0, width: 1, height: 1 }, review_status: 'accepted' }] }, /cannot accept/],
    ];
    for (const [override, pattern] of cases) {
      const args = await makeConfig(override);
      await assert.rejects(createRecapSourcePackage(args), pattern);
      await assert.rejects(fs.access(args.outputDir), { code: 'ENOENT' });
    }
  });

  await test('malformed text/raster and orientation-dependent page inputs fail before ingestion', async () => {
    await fs.writeFile(path.join(scratch, 'binary.txt'), Buffer.from([0xff, 0xfe, 0x80]));
    await fs.writeFile(path.join(scratch, 'fake.png'), 'not a png');
    await sharp({ create: { width: 20, height: 40, channels: 3, background: '#fff' } }).withMetadata({ orientation: 6 }).jpeg().toFile(path.join(scratch, 'oriented.jpg'));
    for (const [source_kind, file, pattern] of [['prose', 'binary.txt', /UTF-8/], ['comic', 'fake.png', /unsupported image|Input buffer/i], ['comic', 'oriented.jpg', /orientation/]]) {
      const args = await makeConfig({ source_kind, files: [{ id: 'input', path: file }] });
      await assert.rejects(createRecapSourcePackage(args), pattern);
      await assert.rejects(fs.access(args.outputDir), { code: 'ENOENT' });
    }
  });

  await test('stale originals, config, snapshots and index artifacts cannot be reused silently', async () => {
    for (const target of ['original', 'config', 'snapshot', 'index']) {
      const tempSource = `mutable-${target}.txt`;
      await fs.writeFile(path.join(scratch, tempSource), 'An unchanged source.');
      const args = await makeConfig({ files: [{ id: 'input', path: tempSource }] });
      const result = await createRecapSourcePackage(args);
      const mutation = { original: path.join(scratch, tempSource), config: args.configPath, snapshot: path.join(args.outputDir, 'sources/input.txt'), index: path.join(args.outputDir, 'text_index.json') }[target];
      await fs.appendFile(mutation, '\n');
      await assert.rejects(loadRecapSourcePackage(result.package_path), /stale/);
      if (target === 'original' || target === 'config') await loadRecapSourcePackage(result.package_path, { verifyOriginals: false });
    }
  });

  await test('episode destinations and symlink aliases into an episode are rejected', async () => {
    const episode = path.join(scratch, 'isolated-run');
    await fs.mkdir(episode); await writeJson(path.join(episode, 'run_identity.json'), {});
    const alias = path.join(scratch, 'alias'); await fs.symlink(episode, alias);
    const args = await makeConfig();
    for (const outputDir of [path.join(episode, 'source'), path.join(alias, 'source'), path.join(scratch, 'episodes/new/source')]) {
      await assert.rejects(createRecapSourcePackage({ ...args, outputDir }), /outside episode/);
    }
  });

  await test('hash-bound artifact paths cannot escape a package through traversal or symlink', async () => {
    const args = await makeConfig();
    const result = await createRecapSourcePackage(args);
    const pkg = result.package;
    const external = path.join(scratch, 'external-index.json');
    const bytes = await fs.readFile(result.text_index_path); await fs.writeFile(external, bytes);
    pkg.artifacts.text_index = { path: '../external-index.json', sha256: hash(bytes) };
    await writeJson(result.package_path, pkg);
    await assert.rejects(loadRecapSourcePackage(result.package_path), /escapes package/);
    await fs.symlink(external, path.join(args.outputDir, 'alias-index.json'));
    pkg.artifacts.text_index.path = 'alias-index.json'; await writeJson(result.package_path, pkg);
    await assert.rejects(loadRecapSourcePackage(result.package_path), /escapes package/);
  });

  await test('paragraph and sentence indexing preserves Unicode and repeated identical paragraphs as separate refs', () => {
    const source = 'Same words.\n\nSame words.\n\nEmoji 🗝️ and CRLF.\r\nNext line!';
    const index = indexRecapText(source, 'chapter');
    assert.equal(index.paragraphs.length, 3);
    assert.notEqual(index.paragraphs[0].id, index.paragraphs[1].id);
    assert.equal(index.paragraphs[0].sha256, index.paragraphs[1].sha256);
    for (const ref of [...index.paragraphs, ...index.sentences]) assert.equal(source.slice(ref.start_char, ref.end_char), ref.text);
  });
  console.log(`${count} recap source package tests passed`);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
