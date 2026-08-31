// Self-hosts Monaco instead of letting @monaco-editor/react fall back to its
// default CDN AMD loader (cdn.jsdelivr.net). This is a renderer with IPC
// powers, so a remote script-src host is a standing RCE surface — see the
// script-src comment in vite.config.ts. Side-effect-on-import: importing this
// module registers `self.MonacoEnvironment` and points loader.config() at the
// locally-installed `monaco-editor` package, so it must be imported (from
// FileEditor.tsx / MonacoDiffViewer.tsx) before either mounts an <Editor> or
// <DiffEditor>.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

// Only the languages monaco ships a dedicated worker for need an entry here
// (json/css/html — css.worker also backs scss/less, and html.worker also backs
// handlebars). MonacoDiffViewer's language maps cover many more extensions
// (python, go, rust, yaml, shell, ...), but those are Monarch tokenizers with no
// worker — they fall through to `editorWorker`, same as this file already does
// for `default`.
//
// TYPESCRIPT IS DELIBERATELY NOT LISTED. `ts.worker` is a single 10.7MB module —
// it embeds the whole TypeScript compiler — and at 6.0MB emitted it was 54% of
// Monaco's build output and the dominant cost of the frontend build's ~2GB heap
// peak. All it buys is type-AWARE intelligence: cross-file autocomplete, hover
// types, red squiggles. Syntax highlighting for ts/tsx/js/jsx is a Monarch
// tokenizer in monaco core and is completely unaffected. The only live Monaco
// surface is the read-mostly diff viewer, where none of that intelligence earns
// its size, so ts/js fall through to `editorWorker` exactly like python and go
// already do. Re-add the import and a `case 'typescript': case 'javascript':`
// arm below if a real editing surface ever ships (see the @cyboflow-hidden
// banner in frontend/src/components/panels/editor/FileEditor.tsx).
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
