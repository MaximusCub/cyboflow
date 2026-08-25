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
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Only the four languages monaco ships a dedicated worker for need an entry
// here (json/css/html/typescript — css.worker also backs scss/less, and
// html.worker also backs handlebars). FileEditor/MonacoDiffViewer's language
// maps cover many more extensions (python, go, rust, yaml, shell, ...), but
// those are Monarch tokenizers with no worker — they fall through to
// `editorWorker`, same as this file already does for `default`.
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
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
