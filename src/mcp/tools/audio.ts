/**
 * The `transcribe` tool: speech to text, locally.
 *
 * Takes a URL or a local path. Reports which engine ran, so a transcript is
 * never anonymous output you cannot judge the quality of.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  transcribeFile,
  transcribeBuffer,
  availableEngines,
  looksLikeAudio,
  engineUnavailableMessage,
} from '../../core/parse/audio.js';
import { fetchPage } from '../../core/fetcher/index.js';
import { fileParseAllowed, lockdownPath } from '../../core/policy/lockdown.js';
import { isHttpUrl } from '../../core/util/url.js';

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

export function registerAudioTools(server: McpServer): void {
  server.registerTool(
    'transcribe',
    {
      title: 'Transcribe audio or video to text',
      description:
        'Speech to text for an audio or video file, by URL or local path, using a local engine — no API, no per-minute billing. Needs a speech model: either a whisper CLI via OPENSCRAPE_WHISPER_CMD, or `npm i @huggingface/transformers`. Says which engine produced the transcript, and says plainly when none is available rather than returning empty text.',
      inputSchema: {
        source: z.string().describe('An http(s) URL or an absolute local path to the audio/video file.'),
        language: z
          .string()
          .optional()
          .describe('Language hint, e.g. "en" or "hi". Omit to let the model detect it.'),
        model: z
          .string()
          .optional()
          .describe('Model for the transformers engine. Default Xenova/whisper-tiny.en. Larger: Xenova/whisper-base, Xenova/whisper-small.'),
        engine: z
          .enum(['cli', 'transformers'])
          .optional()
          .describe('Force one engine instead of trying the CLI first.'),
        timeout: z.number().optional().describe('Milliseconds. Default 600000 (10 min).'),
        maxChars: z.number().optional().describe('Cap the returned transcript.'),
      },
    },
    async (args) => {
      const source = String(args.source);
      const opts = {
        language: args.language as string | undefined,
        model: args.model as string | undefined,
        engine: args.engine as 'cli' | 'transformers' | undefined,
        timeout: args.timeout as number | undefined,
      };

      // Check for an engine before spending a download on a file we cannot read.
      const engines = await availableEngines();
      if (!engines.cli && !engines.transformers) {
        // Derived from the status, never by attempting a transcription: the
        // caller must not be told about a path or URL when the real problem is
        // that no engine exists.
        return text(engineUnavailableMessage(engines), true);
      }

      const isUrl = isHttpUrl(source);

      if (!isUrl && !fileParseAllowed()) {
        return text(
          `Refusing to read local files: allowFileParse is false in ${lockdownPath()}. Pass a URL instead.`,
          true,
        );
      }

      if (!isUrl && !looksLikeAudio(source)) {
        return text(
          `"${source}" does not look like an audio or video file. If it is one, rename it with the right extension — the engine needs it to pick a decoder.`,
          true,
        );
      }

      const result = isUrl
        ? await (async () => {
            // Through fetchPage, so the lockdown, cache and politeness apply to
            // an audio download exactly as they do to a page.
            const outcome = await fetchPage(source, {
              render: 'http',
              timeout: opts.timeout ?? 120_000,
              parseDocuments: false,
            });
            if (outcome.page.status >= 400) {
              return {
                ok: false as const,
                text: '',
                elapsedMs: 0,
                error: `Downloading ${source} returned HTTP ${outcome.page.status}.`,
              };
            }
            if (!looksLikeAudio(source, outcome.page.contentType)) {
              return {
                ok: false as const,
                text: '',
                elapsedMs: 0,
                error: `${source} answered with content-type "${outcome.page.contentType}", which is not audio or video. Nothing was transcribed.`,
              };
            }
            return transcribeBuffer(outcome.page.body, source, opts);
          })()
        : await transcribeFile(source, opts);

      if (!result.ok) return text(result.error ?? 'Transcription failed.', true);

      let body = result.text;
      const max = args.maxChars as number | undefined;
      let truncated = 0;
      if (max && body.length > max) {
        truncated = body.length - max;
        body = body.slice(0, max).trimEnd();
      }

      const bits = [
        `engine: ${result.engine}`,
        result.via ? `via: ${result.via}` : null,
        result.durationMs ? `audio: ${(result.durationMs / 1000).toFixed(1)}s` : null,
        `took ${(result.elapsedMs / 1000).toFixed(1)}s`,
        `${result.text.length} chars`,
      ].filter(Boolean);

      const out = [`# Transcript`, `<${source}> · ${bits.join(' · ')}`, '', body];
      if (truncated) out.push(`\n---\n_[truncated ${truncated} chars]_`);
      // A tiny model on accented speech is roughly 10-15% wrong. Saying which
      // model ran is what lets the reader judge whether to trust a figure in it.
      if (result.engine === 'transformers' && (result.via ?? '').includes('tiny')) {
        out.push(
          `\n_Transcribed with a tiny model, which is the fastest and least accurate. For names, numbers or accented speech, re-run with model:"Xenova/whisper-base" or larger._`,
        );
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'transcribe_engines',
    {
      title: 'Which speech-to-text engines are available',
      description:
        'Reports whether a whisper CLI or @huggingface/transformers is usable right now, and how to enable whichever is missing.',
      inputSchema: {},
    },
    async () => {
      const e = await availableEngines();
      const out = ['# Speech-to-text engines', ''];

      out.push(
        `- **Local CLI** (OPENSCRAPE_WHISPER_CMD): ${e.cli ? '✓ configured' : '✗ not set'}`,
      );
      if (e.cli) out.push(`      ${process.env.OPENSCRAPE_WHISPER_CMD}`);
      if (e.transformers) {
        out.push('- **@huggingface/transformers**: ✓ installed and loading');
      } else if (e.transformersInstalled) {
        out.push('- **@huggingface/transformers**: ⚠ installed but **will not load**');
        if (e.transformersFix) {
          const fixLines = e.transformersFix.split(/\r?\n/).map((l) => `  ${l}`);
          out.push('', '  To fix:', ...fixLines);
        }
        if (e.transformersError) out.push('', `  Load error: \`${e.transformersError}\``);
      } else {
        out.push('- **@huggingface/transformers**: ✗ not installed');
      }

      if (!e.cli && !e.transformers && !e.transformersInstalled) {
        out.push(
          '',
          'Neither is available, so `transcribe` will refuse rather than return empty text.',
          '',
          'Enable one:',
          '',
          '```bash',
          'npm i @huggingface/transformers',
          '```',
          '',
          'Or point at a CLI you already have (faster, and usually more accurate):',
          '',
          '```bash',
          'export OPENSCRAPE_WHISPER_CMD="whisper {input} --model base --output_format txt --output_dir {outdir}"',
          '```',
          '',
          'The template must contain `{input}`; `{outdir}` is optional.',
        );
      } else if (!e.cli) {
        out.push(
          '',
          'The npm engine will be used. The first call downloads the model (~75 MB for tiny.en),',
          'and runs on CPU, so expect roughly real-time or slower on a long recording.',
        );
      }

      return text(out.join('\n'));
    },
  );
}
