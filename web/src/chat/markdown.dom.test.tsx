import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Markdown } from './markdown';

/**
 * Behavioural coverage for the chat Markdown renderer. The safety property is
 * the point: model output is untrusted, so nothing may reach the DOM as HTML,
 * and link targets are filtered to safe protocols by construction.
 */
afterEach(cleanup);

describe('markdown renderer', () => {
  it('renders GFM tables with headers and cells', () => {
    render(
      <Markdown
        text={'| Model | Price |\n| --- | --- |\n| lwrr-text | $0.50/M |\n| lwrr-pro | $1.20/M |'}
      />
    );
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('Model');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.textContent).toContain('$0.50/M');
  });

  it('renders fenced code with a language label and a copy button', async () => {
    render(<Markdown text={'```python\nprint("hi")\n```'} />);
    expect(screen.getByText('python')).toBeTruthy();
    const copy = screen.getByRole('button', { name: /copy python/i });
    expect(screen.getByText(/print/)).toBeTruthy();
    expect(copy).toBeTruthy();
  });

  it('colours diff hunks and terminal prompts', () => {
    const { container } = render(
      <Markdown
        text={'```diff\n+ added line\n- removed line\n```\n```bash\n$ npm run validate\nnpm run build\n```'}
      />
    );
    expect(container.querySelector('.diff-add')?.textContent).toContain('added line');
    expect(container.querySelector('.diff-del')?.textContent).toContain('removed line');
    expect(container.querySelector('.term-prompt')?.textContent).toContain('$');
  });

  it('never turns an unsafe link target into an anchor', () => {
    render(<Markdown text={'click [me](javascript:alert(1)) or [ok](https://example.com)'} />);
    const safe = screen.getByRole('link', { name: 'ok' });
    expect(safe.getAttribute('href')).toBe('https://example.com');
    expect(safe.getAttribute('rel')).toBe('noopener noreferrer');
    // The javascript: target renders as inert text, not a link.
    expect(screen.queryByRole('link', { name: 'me' })).toBeNull();
    expect(document.body.textContent).toContain('me');
  });

  it('supports inline code, bold and lists', () => {
    render(<Markdown text={'- run `npm test` now\n- **bold** item'} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(screen.getByText('npm test').tagName).toBe('CODE');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('copies a code block through the clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Markdown text={'```bash\n$ echo ok\n```'} />);
    await userEvent.click(screen.getByRole('button', { name: /copy bash/i }));
    expect(writeText).toHaveBeenCalledWith('$ echo ok');
  });
});
