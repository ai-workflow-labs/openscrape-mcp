/**
 * Checks the transcription adapter's behaviour WITHOUT a speech model
 * installed, which is the default state and therefore the one that matters.
 *
 * The thing being verified is that it refuses clearly instead of returning an
 * empty transcript. An empty string is indistinguishable from silence, and a
 * caller cannot tell the difference between "nothing was said" and "nothing
 * was tried".
 *
 *   npx tsx scripts/try-audio.ts
 */
import {
  availableEngines,
  transcribeFile,
  looksLikeAudio,
  engineUnavailableMessage,
  type EngineStatus,
} from '../src/core/parse/audio.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
  if (detail && ok) console.log(`        ${detail}`);
}

const engines = await availableEngines();
console.log(`engines: cli=${engines.cli} transformers=${engines.transformers}\n`);

console.log('1. audio detection');
check('mp3 by extension', looksLikeAudio('/tmp/a.mp3'));
check('mp4 by extension', looksLikeAudio('https://x.test/clip.mp4'));
check('by content-type', looksLikeAudio('https://x.test/stream', 'audio/mpeg'));
check('an html page is not audio', !looksLikeAudio('https://x.test/page.html', 'text/html'));

console.log('\n2. a missing file is named, not transcribed');
const missing = await transcribeFile('definitely-not-here.mp3');
if (engines.cli || engines.transformers) {
  check('refused', !missing.ok && /No such file/.test(missing.error ?? ''), missing.error?.slice(0, 80));
} else {
  // With no engine at all, "no engine" is the more useful answer than "no
  // file" — fixing the path would not help.
  check(
    'engine state is reported before the file',
    !missing.ok && !/No such file/.test(missing.error ?? ''),
    'engine problem reported instead of the path, which is the actionable one',
  );
}

if (engines.transformersInstalled && !engines.transformers) {
  console.log('\n3. the engine is installed but will not load — the diagnosis must be specific');
  const r = await transcribeFile('definitely-not-here.mp3');
  check('does not claim it is uninstalled', !/npm i @huggingface/.test(r.error ?? ''));
  check('says it is installed but will not load', /installed but will not load/.test(r.error ?? ''));
  check('includes the load error', /onnxruntime_binding\.node/.test(r.error ?? ''));
  check('names a concrete fix', /VCRedist|vc_redist|npm rebuild/.test(r.error ?? ''));
  check('offers the CLI alternative', /OPENSCRAPE_WHISPER_CMD/.test(r.error ?? ''));
  console.log('\n  the message a caller actually sees:');
  for (const line of (r.error ?? '').split('\n')) console.log(`    ${line}`);
} else if (!engines.cli && !engines.transformers) {
  console.log('\n3. with no engine, the refusal explains both install routes');
  // A real file is needed, so the "no such file" branch is not what answers.
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'openscrape-audio-test-'));
  const file = join(dir, 'silence.wav');
  writeFileSync(file, Buffer.alloc(64));

  const r = await transcribeFile(file);
  check('refused rather than returning empty text', !r.ok && r.text === '');
  check('names the npm route', /@huggingface\/transformers/.test(r.error ?? ''));
  check('names the CLI route', /OPENSCRAPE_WHISPER_CMD/.test(r.error ?? ''));
  check('states that nothing was guessed', /no text is being guessed at/.test(r.error ?? ''));

  console.log('\n  the message a caller actually sees:');
  for (const line of (r.error ?? '').split('\n')) console.log(`    ${line}`);
} else {
  console.log('\n3. an engine IS available, so the refusal path cannot be checked here.');
  console.log('   Unset OPENSCRAPE_WHISPER_CMD and uninstall the package to test it.');
}

console.log('\n4. a bad CLI template is rejected before anything runs');
process.env.OPENSCRAPE_WHISPER_CMD = 'whisper --model base';
const { writeFileSync, mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir2 = mkdtempSync(join(tmpdir(), 'openscrape-audio-test2-'));
const file2 = join(dir2, 'x.wav');
writeFileSync(file2, Buffer.alloc(64));
const noInput = await transcribeFile(file2, { engine: 'cli' });
check(
  'a template without {input} is refused',
  !noInput.ok && /must contain \{input\}/.test(noInput.error ?? ''),
  noInput.error?.slice(0, 100),
);
delete process.env.OPENSCRAPE_WHISPER_CMD;

// The refusal messages are checked against synthetic states, not just against
// whatever this machine happens to be in. Once an engine is working here, the
// branches above stop running — and "it refuses clearly" is the behaviour that
// matters most, so it cannot be allowed to go untested the moment it starts
// working on one developer's laptop.
console.log('\n5. refusal messages, for every engine state');

const notInstalled: EngineStatus = { cli: false, transformers: false, transformersInstalled: false };
const broken: EngineStatus = {
  cli: false,
  transformers: false,
  transformersInstalled: true,
  transformersError: 'Error: The specified module could not be found. onnxruntime_binding.node',
  transformersFix: 'onnxruntime needs the Microsoft Visual C++ Redistributable...',
};

const msgNotInstalled = engineUnavailableMessage(notInstalled);
check('absent engine: offers the npm install', /npm i @huggingface\/transformers/.test(msgNotInstalled));
check('absent engine: offers the CLI route', /OPENSCRAPE_WHISPER_CMD/.test(msgNotInstalled));
check('absent engine: states nothing was guessed', /no text is being guessed at/.test(msgNotInstalled));

const msgBroken = engineUnavailableMessage(broken);
check('broken engine: does NOT tell you to install it again', !/npm i @huggingface/.test(msgBroken));
check('broken engine: says installed but will not load', /installed but will not load/.test(msgBroken));
check('broken engine: includes the load error', /onnxruntime_binding\.node/.test(msgBroken));
check('broken engine: carries the fix', /Visual C\+\+ Redistributable/.test(msgBroken));
check('broken engine: offers the CLI alternative', /OPENSCRAPE_WHISPER_CMD/.test(msgBroken));

// The two messages must be different. If a refactor ever collapses them, the
// "already installed" case silently starts telling people to reinstall.
check('the two states give different messages', msgNotInstalled !== msgBroken);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
