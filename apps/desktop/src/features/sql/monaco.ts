import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { SqlTable } from '@/lib/api';
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
export { monaco };
export function autocomplete(tables: SqlTable[]) {
  return monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', '"'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const table = before.match(/([a-zA-Z_][\w]*)\.$/)?.[1];
      const columns = tables
        .filter((t) => !table || t.name === table)
        .flatMap((t) =>
          t.columns.map((c) => ({
            label: c.name,
            insertText: quote(c.name),
            detail: t.schema + '.' + t.name + ' · ' + c.type,
            kind: monaco.languages.CompletionItemKind.Field,
            range,
          })),
        );
      return {
        suggestions: [
          ...tables.map((t) => ({
            label: t.schema + '.' + t.name,
            insertText: quote(t.schema) + '.' + quote(t.name),
            kind: monaco.languages.CompletionItemKind.Class,
            range,
          })),
          ...[...new Set(tables.map((t) => t.schema))].map((s) => ({
            label: s,
            insertText: quote(s),
            kind: monaco.languages.CompletionItemKind.Module,
            range,
          })),
          ...columns,
          ...'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL IS IN WITH DISTINCT UNION ALL CASE WHEN THEN ELSE END COUNT SUM AVG MIN MAX'
            .split(' ')
            .map((k) => ({
              label: k,
              insertText: k,
              kind: monaco.languages.CompletionItemKind.Keyword,
              range,
            })),
        ],
      };
    },
  });
}
export function editorTheme(dark: boolean) {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = css.getPropertyValue(name).trim();
    ctx.fillRect(0, 0, 1, 1);
    return (
      '#' +
      Array.from(ctx.getImageData(0, 0, 1, 1).data)
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('')
    );
  };
  const name = dark ? 'straton-dark' : 'straton-light';
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: color('--primary').replace('#', '') },
      { token: 'comment', foreground: color('--ink-3').replace('#', '') },
      { token: 'number', foreground: color('--ink').replace('#', '') },
    ],
    colors: {
      'editor.background': color('--bg'),
      'editor.foreground': color('--ink'),
      'editorLineNumber.foreground': color('--ink-3'),
      'editor.selectionBackground': color('--primary-tint'),
      'editor.lineHighlightBackground': color('--surface-2'),
      'editorCursor.foreground': color('--primary'),
      'editorWidget.background': color('--surface'),
      'editorWidget.border': color('--line'),
    },
  });
  monaco.editor.setTheme(name);
  return name;
}
