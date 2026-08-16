import { Fragment, type ReactNode } from 'react';
import { CopyButton } from '../components/copy';

/**
 * A small, dependency-free Markdown renderer built for chat messages.
 *
 * Everything is produced as React elements: model output is untrusted text, so
 * there is no `dangerouslySetInnerHTML` and therefore no sanitiser to forget.
 * Supported blocks: fenced code (plain, diff, bash, powershell + a light token
 * highlight for common languages), headings, lists, tables, block quotes,
 * rules and paragraphs; inline code, bold, italics and safe links.
 */

const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  md: 'markdown'
};

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  javascript: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class',
    'new', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'import', 'from',
    'export', 'default', 'typeof', 'null', 'undefined', 'true', 'false', 'this'
  ]),
  python: new Set([
    'def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for', 'while',
    'with', 'as', 'try', 'except', 'finally', 'raise', 'lambda', 'None', 'True',
    'False', 'not', 'in', 'is', 'pass', 'yield', 'async', 'await'
  ]),
  bash: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case',
    'esac', 'function', 'echo', 'export', 'local', 'return', 'source'
  ]),
  json: new Set(['true', 'false', 'null']),
  typescript: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class',
    'new', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'import', 'from',
    'export', 'default', 'typeof', 'null', 'undefined', 'true', 'false', 'this',
    'interface', 'type', 'enum', 'implements', 'extends', 'readonly'
  ])
};

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;

function normalizeLang(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return LANG_ALIASES[lower] ?? lower;
}

/** Only same-origin, http(s) and mailto targets become anchors. */
function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:|\/)/i.test(url) ? url : null;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(INLINE_RE)
    .map((part, index) => {
      const key = `${keyPrefix}-${index}`;
      if (!part) return null;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={key} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={key} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
        return <em key={key}>{part.slice(1, -1)}</em>;
      }
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const label = link[1] ?? '';
        const url = link[2] ?? '';
        const href = safeHref(url);
        if (!href) return <Fragment key={key}>{label}</Fragment>;
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
          >
            {renderInline(label, key)}
          </a>
        );
      }
      return <Fragment key={key}>{part}</Fragment>;
    })
    .filter((node) => node !== null);
}

/**
 * Best-effort token colouring for common languages: comments, strings and
 * numbers first, then keywords. Deliberately regex-simple — a chat message
 * does not need a parser, and a wrong colour is harmless while raw HTML would
 * not be.
 */
function highlight(code: string, lang: string): ReactNode[] {
  const keywords = KEYWORDS[lang];
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(code); match !== null; match = TOKEN_RE.exec(code)) {
    if (match.index > last) out.push(<Fragment key={`t${index++}`}>{code.slice(last, match.index)}</Fragment>);
    const token = match[0] ?? '';
    let cls = '';
    if (token.startsWith('//') || token.startsWith('#')) cls = 'tok-c';
    else if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) cls = 'tok-s';
    else if (/^\d/.test(token)) cls = 'tok-n';
    else if (keywords?.has(token)) cls = 'tok-k';
    out.push(
      cls ? (
        <span key={`k${index++}`} className={cls}>
          {token}
        </span>
      ) : (
        <Fragment key={`k${index++}`}>{token}</Fragment>
      )
    );
    last = match.index + token.length;
  }
  if (last < code.length) out.push(<Fragment key={`t${index++}`}>{code.slice(last)}</Fragment>);
  return out;
}

function CodeHeader({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <CopyButton value={code} compact label={`Copy ${label}`} />
    </div>
  );
}

function DiffBlock({ code }: { code: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <div className="codeblock">
      <CodeHeader label="diff" code={code} />
      <pre>
        {lines.map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'diff-add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'diff-del'
                  : 'diff-meta'
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * Terminal flavour for shell scripts: lines that carry the conventional prompt
 * glyph get it tinted, everything else stays plain so copied text is runnable.
 */
function TerminalBlock({ lang, code }: { lang: 'bash' | 'powershell'; code: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  const isPowershell = lang === 'powershell';
  return (
    <div className="codeblock">
      <CodeHeader label={isPowershell ? 'powershell' : 'bash'} code={code} />
      <pre>
        {lines.map((line, index) => {
          const prompt = isPowershell ? /^PS[^>\s]*>\s?/ : /^\$\s?/;
          const match = prompt.exec(line);
          const marker = match?.[0];
          return (
            <span key={index}>
              {marker && <span className="term-prompt">{marker}</span>}
              {marker ? line.slice(marker.length) : line}
              {'\n'}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  if (lang === 'diff') return <DiffBlock code={code} />;
  if (lang === 'bash' || lang === 'powershell') return <TerminalBlock lang={lang} code={code} />;
  return (
    <div className="codeblock">
      {lang && <CodeHeader label={lang} code={code} />}
      <pre>{lang ? highlight(code, lang) : code}</pre>
    </div>
  );
}

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'para'; text: string };

const FENCE_RE = /^```([A-Za-z0-9_+-]*)\s*$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const RULE_RE = /^\s*(-{3,}|\*{3,})\s*$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function looksLikeTable(line: string, next: string | undefined): boolean {
  return (
    line.includes('|') && next !== undefined && next.includes('|') && TABLE_SEP_RE.test(next)
  );
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  // Out-of-range lookups return '' rather than undefined: the parser peeks at
  // i + 1 for table separators and may legitimately run past the last line.
  const lineAt = (index: number): string => (index >= 0 && index < lines.length ? lines[index] ?? '' : '');
  let i = 0;

  while (i < lines.length) {
    const line = lineAt(i);

    const fence = FENCE_RE.exec(line.trim());
    if (fence) {
      const lang = fence[1] ? normalizeLang(fence[1]) : '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lineAt(i).trim() !== '```') {
        body.push(lineAt(i));
        i += 1;
      }
      i += 1; // closing fence, or past the end for an unclosed block
      blocks.push({ kind: 'code', lang, code: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lineAt(i).trimStart().startsWith('>')) {
        quoted.push(lineAt(i).trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: string[] = [];
      while (i < lines.length) {
        const candidate = ordered ? OL_RE.exec(lineAt(i)) : UL_RE.exec(lineAt(i));
        if (!candidate) break;
        items.push(candidate[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (looksLikeTable(line, lineAt(i + 1))) {
      const header = splitRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lineAt(i).includes('|') && lineAt(i).trim()) {
        rows.push(splitRow(lineAt(i)));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lineAt(i);
      if (
        !next.trim() ||
        FENCE_RE.test(next.trim()) ||
        HEADING_RE.test(next) ||
        RULE_RE.test(next) ||
        UL_RE.test(next) ||
        OL_RE.test(next) ||
        next.trimStart().startsWith('>') ||
        looksLikeTable(next, lineAt(i + 1))
      ) {
        break;
      }
      paragraph.push(next.trim());
      i += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: 'para', text: paragraph.join(' ') });
  }

  return blocks;
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'text-lg font-semibold tracking-tight',
  2: 'text-base font-semibold tracking-tight',
  3: 'text-sm font-semibold',
  4: 'text-sm font-medium'
};

function BlockView({ block, index }: { block: Block; index: number }): ReactNode {
  switch (block.kind) {
    case 'code':
      return <CodeBlock lang={block.lang} code={block.code} />;
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag className={HEADING_CLASSES[block.level] ?? ''}>{renderInline(block.text, `h${index}`)}</Tag>;
    }
    case 'rule':
      return <hr className="border-border/70" />;
    case 'quote':
      return (
        <blockquote className="border-l-2 border-border pl-3 text-muted">
          {block.lines.map((line, lineIndex) => (
            <p key={lineIndex}>{renderInline(line, `q${index}-${lineIndex}`)}</p>
          ))}
        </blockquote>
      );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List className={block.ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `l${index}-${itemIndex}`)}</li>
          ))}
        </List>
      );
    }
    case 'table':
      return (
        <div className="codeblock">
          <div className="overflow-x-auto">
            <table className="doc-table">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th key={cellIndex}>{renderInline(cell, `th${index}-${cellIndex}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{renderInline(cell, `td${index}-${rowIndex}-${cellIndex}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case 'para':
      return <p>{renderInline(block.text, `p${index}`)}</p>;
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 space-y-2.5 break-words">
      {parseBlocks(text).map((block, index) => (
        <BlockView key={index} block={block} index={index} />
      ))}
    </div>
  );
}

export { parseBlocks };
