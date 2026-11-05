/**
 * Speech to text.
 *
 * Firecrawl offers an `audio` format. Matching it locally means running a
 * speech model, and that is the one capability in this project that cannot be
 * made free *and* weightless: transcription needs a model, and a model is
 * hundreds of megabytes.
 *
 * So this is an adapter rather than a bundled engine. It tries, in order:
 *
 *   1. `OPENSCRAPE_WHISPER_CMD` — any local CLI (whisper.cpp, faster-whisper,
 *      openai-whisper). Fastest and best quality if you already have one.
 *   2. `@huggingface/transformers` — Whisper ONNX, downloaded on first use.
 *      Pure npm, no system dependency, but the first call fetches the model.
 *   3. Nothing — and then it says so, with both install options, rather than
 *      returning an empty transcript that reads like silence.
 *
 * Deliberately not installed by default: adding a few hundred megabytes to
 * `npm install` for a format most callers never use is not a trade worth
 * making silently.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { log } from '../util/log.js';

/**
 * Held in a variable, not written as a literal, on purpose.
 *
 * This package is an optional peer: the whole point of the adapter is that it
 * works without it. A literal `import(TRANSFORMERS)` makes
 * TypeScript resolve the module at compile time, so the project would not
 * typecheck on a machine that has not installed it — which is every machine
 * by default. A non-literal specifier keeps the import dynamic.
 */
const TRANSFORMERS = '@huggingface/transformers';

export type TranscribeEngine = 'cli' | 'transformers';

export interface TranscribeOptions {
  /** BCP-47 or ISO-639-1 hint, e.g. "en", "hi". Omit to let the model guess. */
  language?: string;
  /** Model name for the transformers engine. Default "Xenova/whisper-tiny.en". */
  model?: string;
  /** Hard ceiling in ms. A long recording on CPU is slow; default 10 minutes. */
  timeout?: number;
  /** Force one engine instead of trying both. */
  engine?: TranscribeEngine;
}

export interface TranscribeResult {
  ok: boolean;
  text: string;
  engine?: TranscribeEngine;
  /** What produced it, for the record: CLI command or model id. */
  via?: string;
  language?: string;
  durationMs?: number;
  elapsedMs: number;
  /** Set when `ok` is false: why, and what to install. */
  error?: string;
}

const AUDIO_EXT = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm',
  '.mp4', '.m4b', '.mkv', '.mov', '.wma', '.aiff', '.aif',
]);

export function looksLikeAudio(pathOrUrl: string, contentType = ''): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('audio/') || ct.startsWith('video/')) return true;
  const ext = extname(new URL(pathOrUrl, 'file:///').pathname).toLowerCase();
  return AUDIO_EXT.has(ext);
}

/**
 * The message shown when no engine is available. Both routes, no guessing.
 *
 * Exported so a caller can ask for it directly. It used to be reachable only
 * by attempting a transcription, which meant a caller with no engine had to
 * pass a path to find out — and got "No such file" about a probe path it never
 * supplied instead of the real answer.
 */
export const NO_ENGINE =
  'No speech-to-text engine is available, so this audio was not transcribed. ' +
  'Two ways to enable it:\n\n' +
  '  1. A local CLI you may already have, which is faster and usually better:\n' +
  '       set OPENSCRAPE_WHISPER_CMD to a command containing {input}, e.g.\n' +
  '       OPENSCRAPE_WHISPER_CMD="whisper {input} --model base --output_format txt --output_dir {outdir}"\n' +
  '       (whisper.cpp, faster-whisper and openai-whisper all work this way)\n\n' +
  '  2. Pure npm, no system dependency:\n' +
  '       npm i @huggingface/transformers\n' +
  '       The first call then downloads a Whisper model (~75 MB for tiny.en).\n\n' +
  'Nothing was transcribed and no text is being guessed at.';

/* ------------------------------------------------------------------ */
/* Engine 1: a local CLI                                               */
/* ------------------------------------------------------------------ */

function runCommand(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`transcription timed out after ${timeout}ms`));
    }, timeout);

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Splits a command template the way a shell would, but without a shell.
 *
 * Running the operator's template through `sh -c` would make it a shell
 * injection point reachable from a file name. The template is the operator's,
 * but the file name is not, so the two are kept apart: the template is split
 * into argv here and the paths are substituted as whole arguments.
 */
function buildArgv(template: string, input: string, outdir: string): string[] {
  const parts = template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((raw) => {
    const unquoted = raw.replace(/^["']|["']$/g, '');
    return unquoted.replace('{input}', input).replace('{outdir}', outdir);
  });
}

async function transcribeWithCli(
  file: string,
  opts: TranscribeOptions,
): Promise<TranscribeResult | null> {
  const template = process.env.OPENSCRAPE_WHISPER_CMD?.trim();
  if (!template) return null;

  const started = Date.now();
  const timeout = opts.timeout ?? 600_000;
  const outdir = await mkdtemp(join(tmpdir(), 'openscrape-stt-'));

  try {
    const argv = buildArgv(template, file, outdir);
    const command = argv[0];
    if (!command) {
      return {
        ok: false,
        text: '',
        elapsedMs: Date.now() - started,
        error: 'OPENSCRAPE_WHISPER_CMD is set but empty.',
      };
    }
    if (!template.includes('{input}')) {
      return {
        ok: false,
        text: '',
        elapsedMs: Date.now() - started,
        error:
          'OPENSCRAPE_WHISPER_CMD must contain {input} so the audio file can be passed to it. ' +
          `Got: ${template}`,
      };
    }

    log.debug('transcribing via CLI', { command, file: basename(file) });
    const result = await runCommand(command, argv.slice(1), timeout);

    // Most CLIs write a .txt beside the audio or into --output_dir; some print
    // to stdout. Both are accepted, file first since it is the cleaner output.
    let text = '';
    const stem = basename(file, extname(file));
    for (const candidate of [
      join(outdir, `${stem}.txt`),
      join(outdir, `${basename(file)}.txt`),
      `${file}.txt`,
      join(outdir, 'output.txt'),
    ]) {
      if (existsSync(candidate)) {
        text = await readFile(candidate, 'utf8');
        break;
      }
    }
    if (!text.trim()) text = result.stdout;

    if (!text.trim()) {
      return {
        ok: false,
        text: '',
        engine: 'cli',
        via: command,
        elapsedMs: Date.now() - started,
        error:
          `${command} exited with code ${result.code} and produced no transcript. ` +
          `stderr: ${result.stderr.slice(0, 400) || '(empty)'}`,
      };
    }

    return {
      ok: true,
      text: text.trim(),
      engine: 'cli',
      via: command,
      language: opts.language,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      engine: 'cli',
      elapsedMs: Date.now() - started,
      error: `OPENSCRAPE_WHISPER_CMD failed: ${String(err)}`,
    };
  } finally {
    await rm(outdir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Engine 2: transformers.js                                           */
/* ------------------------------------------------------------------ */

/**
 * A WAV decoder, so the common case needs nothing installed.
 *
 * transformers.js can decode audio, but in Node it leans on the platform for
 * compressed formats, and this machine has no ffmpeg. Parsing RIFF by hand is
 * forty lines and removes that dependency for the one format every tool can
 * produce — which is what makes the error message's promise ("a 16 kHz WAV
 * always works") true rather than aspirational.
 *
 * Returns null for anything that is not PCM or IEEE-float WAV, so the caller
 * falls through to the library.
 */
function decodeWav(buf: Buffer): { pcm: Float32Array; rate: number } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let data: Buffer | null = null;

  // Chunks are walked rather than assumed at fixed offsets: real files carry
  // LIST/INFO chunks before `data` often enough that fixed offsets break.
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!data || !channels || !rate) return null;

  // 1 = PCM, 3 = IEEE float. Anything else (ADPCM, mp3-in-wav) is the
  // library's problem, not ours.
  const bytesPerSample = bits / 8;
  let read: ((i: number) => number) | null = null;
  if (format === 1 && bits === 16) read = (i) => data!.readInt16LE(i) / 32768;
  else if (format === 1 && bits === 32) read = (i) => data!.readInt32LE(i) / 2147483648;
  else if (format === 1 && bits === 8) read = (i) => (data![i]! - 128) / 128;
  else if (format === 3 && bits === 32) read = (i) => data!.readFloatLE(i);
  if (!read) return null;

  const frames = Math.floor(data.length / (bytesPerSample * channels));
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += read(f * bytesPerSample * channels + c * bytesPerSample);
    }
    mono[f] = sum / channels; // downmix; Whisper wants mono
  }

  return { pcm: mono, rate };
}

/**
 * Linear resampling to 16 kHz.
 *
 * Crude by signal-processing standards — no anti-aliasing filter — but speech
 * recognition is robust to it, and the alternative is another dependency for a
 * step whose output a 39M-parameter model is about to consume anyway.
 */
function resampleTo16k(pcm: Float32Array, rate: number): Float32Array {
  if (rate === 16_000) return pcm;
  const ratio = rate / 16_000;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, pcm.length - 1);
    const frac = pos - a;
    out[i] = (pcm[a] ?? 0) * (1 - frac) + (pcm[b] ?? 0) * frac;
  }
  return out;
}

/** Decodes to the 16 kHz mono Float32 that Whisper expects. */
async function decodeToPcm(file: string): Promise<{ pcm: Float32Array; durationMs: number } | null> {
  // Our own WAV path first: no ffmpeg, no platform audio API, no surprises.
  try {
    const raw = await readFile(file);
    const wav = decodeWav(raw);
    if (wav) {
      const pcm = resampleTo16k(wav.pcm, wav.rate);
      log.debug('decoded wav locally', { rate: wav.rate, seconds: (pcm.length / 16_000).toFixed(1) });
      return { pcm, durationMs: Math.round((pcm.length / 16_000) * 1000) };
    }
  } catch (err) {
    log.debug('local wav decode failed', String(err));
  }

  // Anything else: let the library try, which may need ffmpeg present.
  try {
    const mod = (await import(TRANSFORMERS)) as unknown as {
      read_audio?: (url: string, rate: number) => Promise<Float32Array>;
    };
    if (!mod.read_audio) return null;
    const pcm = await mod.read_audio(`file://${file.replace(/\\/g, '/')}`, 16_000);
    return { pcm, durationMs: Math.round((pcm.length / 16_000) * 1000) };
  } catch (err) {
    log.debug('audio decode failed', String(err));
    return null;
  }
}

async function transcribeWithTransformers(
  file: string,
  opts: TranscribeOptions,
): Promise<TranscribeResult | null> {
  const started = Date.now();
  const model = opts.model ?? 'Xenova/whisper-tiny.en';

  let pipeline: unknown;
  try {
    const mod = (await import(TRANSFORMERS)) as unknown as {
      pipeline: (task: string, model: string) => Promise<unknown>;
    };
    pipeline = mod.pipeline;
  } catch {
    return null; // Not installed. The caller reports NO_ENGINE.
  }

  try {
    const decoded = await decodeToPcm(file);
    if (!decoded) {
      return {
        ok: false,
        text: '',
        engine: 'transformers',
        via: model,
        elapsedMs: Date.now() - started,
        error:
          'The audio could not be decoded. @huggingface/transformers needs ffmpeg available for ' +
          'compressed formats; a 16 kHz WAV always works.',
      };
    }

    log.info('transcribing locally', { model, seconds: Math.round(decoded.durationMs / 1000) });
    const make = pipeline as (task: string, model: string) => Promise<unknown>;
    const asr = (await make('automatic-speech-recognition', model)) as (
      input: Float32Array,
      options?: Record<string, unknown>,
    ) => Promise<{ text?: string }>;

    const out = await asr(decoded.pcm, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(opts.language ? { language: opts.language } : {}),
    });

    const text = (out.text ?? '').trim();
    if (!text) {
      return {
        ok: false,
        text: '',
        engine: 'transformers',
        via: model,
        durationMs: decoded.durationMs,
        elapsedMs: Date.now() - started,
        error: 'The model returned no text. The recording may be silent.',
      };
    }

    return {
      ok: true,
      text,
      engine: 'transformers',
      via: model,
      language: opts.language,
      durationMs: decoded.durationMs,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      engine: 'transformers',
      via: model,
      elapsedMs: Date.now() - started,
      error: `Local transcription failed: ${String(err)}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export interface EngineStatus {
  cli: boolean;
  transformers: boolean;
  /** True when the package is present but will not load. */
  transformersInstalled: boolean;
  /** The load failure, when there is one. */
  transformersError?: string;
  /** What to do about it, when the cause is recognisable. */
  transformersFix?: string;
}

/**
 * Which engines are usable right now, without running one.
 *
 * "Installed" and "usable" are tracked separately, and that distinction is not
 * academic: `@huggingface/transformers` pulls in `onnxruntime-node`, a native
 * addon that fails to load on a Windows machine with no Visual C++ runtime.
 * Reporting that as "not installed" sends you to `npm i` for a package you
 * already have, so the real reason is captured and passed on instead.
 */
export async function availableEngines(): Promise<EngineStatus> {
  const cli = Boolean(process.env.OPENSCRAPE_WHISPER_CMD?.trim());

  try {
    await import(TRANSFORMERS);
    return { cli, transformers: true, transformersInstalled: true };
  } catch (err) {
    const message = String(err);
    const installed = !/Cannot find (module|package) ['"]?@huggingface\/transformers/.test(message);

    let fix: string | undefined;
    if (!installed) {
      fix = 'npm i @huggingface/transformers';
    } else if (/onnxruntime_binding\.node/.test(message)) {
      // The addon file is present (the error names its full path) but a DLL it
      // depends on is not. On Windows that is almost always the MSVC runtime,
      // which onnxruntime requires and which Windows does not ship by default.
      fix =
        process.platform === 'win32'
          ? 'onnxruntime needs the Microsoft Visual C++ Redistributable, which is not installed on this machine. ' +
            'Install it once (admin required):\n' +
            '    winget install --id Microsoft.VCRedist.2015+.x64\n' +
            '  or download vc_redist.x64.exe from https://aka.ms/vs/17/release/vc_redist.x64.exe\n' +
            '  Then no reinstall of the npm package is needed.'
          : 'The onnxruntime native addon could not load its shared libraries. ' +
            'Reinstalling may fix it: npm rebuild onnxruntime-node';
    }

    return {
      cli,
      transformers: false,
      transformersInstalled: installed,
      transformersError: message.slice(0, 400),
      transformersFix: fix,
    };
  }
}

/**
 * The right "no engine" message for a given state, without touching the input.
 *
 * Built from the status alone on purpose. The first version of this reached the
 * message by *attempting* a transcription, which meant a caller with no engine
 * got "No such file" about whatever path or URL happened to be at hand instead
 * of the actual answer. Twice — once with a fake probe path, once with a real
 * URL. Deriving it from the status removes the whole class of mistake.
 */
export function engineUnavailableMessage(status: EngineStatus): string {
  if (!status.transformersInstalled) return NO_ENGINE;
  return (
    '@huggingface/transformers is installed but will not load, so nothing was transcribed.\n\n' +
    `  ${status.transformersFix ?? 'Cause unknown.'}\n\n` +
    `Load error: ${status.transformersError}\n\n` +
    'Alternatively, point OPENSCRAPE_WHISPER_CMD at a whisper CLI, which needs none of this.'
  );
}

export async function transcribeFile(
  file: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const started = Date.now();

  // Engine availability is checked before the file, so a caller with no usable
  // engine is told that rather than being told about the file.
  const status = await availableEngines();
  if (!status.cli && !status.transformers) {
    return {
      ok: false,
      text: '',
      elapsedMs: Date.now() - started,
      error: engineUnavailableMessage(status),
    };
  }

  if (!existsSync(file)) {
    return { ok: false, text: '', elapsedMs: Date.now() - started, error: `No such file: ${file}` };
  }

  const order: TranscribeEngine[] = opts.engine ? [opts.engine] : ['cli', 'transformers'];
  for (const engine of order) {
    const result =
      engine === 'cli' ? await transcribeWithCli(file, opts) : await transcribeWithTransformers(file, opts);
    // null means "this engine is not configured"; a result means it ran, and a
    // failed run is reported rather than silently falling through to the next.
    if (result) return result;
  }

  return {
    ok: false,
    text: '',
    elapsedMs: Date.now() - started,
    error: opts.engine
      ? `The "${opts.engine}" engine is not available.\n\n${engineUnavailableMessage(status)}`
      : engineUnavailableMessage(status),
  };
}

/** Transcribes audio already in memory, by writing it to a temp file first. */
export async function transcribeBuffer(
  body: Buffer,
  nameHint: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'openscrape-audio-'));
  const ext = extname(nameHint) || '.mp3';
  const file = join(dir, `audio${ext}`);
  try {
    await writeFile(file, body);
    return await transcribeFile(file, opts);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
