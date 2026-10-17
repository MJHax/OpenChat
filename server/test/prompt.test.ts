import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildMessages, FILE_INSTRUCTIONS_HEADER, fileInstructions, pdfPlugins, replySystemPrompt } from '../src/prompt';
import type { Attachment } from '../../shared/types';

const empty = { aboutMe: '', customInstructions: '', memories: [] };

describe('buildSystemPrompt', () => {
  it('returns null when everything is empty or whitespace', () => {
    expect(buildSystemPrompt(empty)).toBeNull();
    expect(buildSystemPrompt({ aboutMe: '  ', customInstructions: '\n', memories: [' '] })).toBeNull();
  });

  it('includes only non-empty sections in order', () => {
    expect(buildSystemPrompt({ aboutMe: 'I am Sam.', customInstructions: '', memories: ['Likes tea', 'Has a dog'] })).toBe(
      'About the user:\nI am Sam.\n\nThings to remember about the user:\n- Likes tea\n- Has a dog',
    );
    expect(buildSystemPrompt({ ...empty, customInstructions: 'Be brief.' })).toBe('Instructions:\nBe brief.');
  });
});

describe('buildMessages', () => {
  const path = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
  ];

  it('prepends the system prompt when present', () => {
    expect(buildMessages({ ...empty, aboutMe: 'Sam' }, path)).toEqual([
      { role: 'system', content: 'About the user:\nSam' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('omits the system message when there is no persona', () => {
    expect(buildMessages(empty, path)).toEqual(path);
  });
});

describe('buildMessages with attachments', () => {
  const file = (id: string, kind: Attachment['kind'], filename: string, mime: string): Attachment => ({ id, kind, filename, mime, size: 1 });
  const data: Record<string, Buffer> = { t: Buffer.from('# A'), i: Buffer.from([1, 2]), p: Buffer.from('%PDF-1') };
  const loadData = (id: string) => data[id];
  const user = {
    role: 'user' as const,
    content: 'Look',
    attachments: [file('t', 'text', 'a.md', 'text/plain'), file('i', 'image', 'photo.png', 'image/png'), file('p', 'pdf', 'doc.pdf', 'application/pdf')],
  };

  it('turns attachments into parts: text, text files, images, PDFs', () => {
    const [msg] = buildMessages(empty, [user], { inputModalities: ['text', 'image'], loadData });
    expect(msg).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'text', text: '<file name="a.md">\n# A\n</file>' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data.i.toString('base64')}` } },
        { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${data.p.toString('base64')}` } },
      ],
    });
  });

  it('replaces images with a note for models that cannot view them', () => {
    const [msg] = buildMessages(empty, [user], { inputModalities: ['text'], loadData });
    expect((msg.content as { type: string; text?: string }[])[2]).toEqual({
      type: 'text', text: '[Image "photo.png" was attached here, but this model can\'t view images.]',
    });
  });

  it('leaves out the text part of an attachment-only message and keeps plain messages as strings', () => {
    const [msg, reply] = buildMessages(
      empty,
      [{ role: 'user', content: '', attachments: [user.attachments[0]] }, { role: 'assistant', content: 'ok', attachments: [] }],
      { inputModalities: ['text'], loadData },
    );
    expect(msg.content).toEqual([{ type: 'text', text: '<file name="a.md">\n# A\n</file>' }]);
    expect(reply.content).toBe('ok');
  });

  it('escapes quotes and ampersands in the file name', () => {
    const [msg] = buildMessages(
      empty,
      [{ role: 'user', content: '', attachments: [file('t', 'text', 'say "hi" & bye.md', 'text/plain')] }],
      { inputModalities: ['text'], loadData },
    );
    expect(msg.content).toEqual([{ type: 'text', text: '<file name="say &quot;hi&quot; &amp; bye.md">\n# A\n</file>' }]);
  });
});

describe('pdfPlugins', () => {
  const pdf: Attachment = { id: 'p', kind: 'pdf', filename: 'doc.pdf', mime: 'application/pdf', size: 1 };
  it('picks the engine only when the prompt has a PDF', () => {
    expect(pdfPlugins([{ attachments: [] }, {}], ['text', 'file'])).toBeUndefined();
    expect(pdfPlugins([{ attachments: [pdf] }], ['text', 'file'])).toEqual([{ id: 'file-parser', pdf: { engine: 'native' } }]);
    expect(pdfPlugins([{ attachments: [pdf] }], ['text'])).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
  });
});

describe('fileInstructions', () => {
  it('explains the format', () => {
    const text = fileInstructions([]);
    expect(text.startsWith(FILE_INSTRUCTIONS_HEADER)).toBe(true);
    expect(text).toContain('<file name="');
    expect(text).toContain('</file>');
    expect(text).toContain('same name');
    expect(text).toContain('self-contained');
    expect(text).toContain('@page');
  });

  it('lists attached image names only when there are some', () => {
    expect(fileInstructions(['beach.jpg', 'cat.png'])).toContain('beach.jpg, cat.png');
    expect(fileInstructions([])).not.toContain('Images attached');
  });

  it('stays short', () => {
    expect(fileInstructions(['a.png']).length).toBeLessThan(1000);
  });
});

describe('replySystemPrompt', () => {
  it('is just the file section for an empty persona', () => {
    expect(replySystemPrompt(empty, [])).toBe(fileInstructions([]));
  });

  it('puts the persona first', () => {
    expect(replySystemPrompt({ ...empty, aboutMe: 'Sam' }, [])).toBe(`About the user:\nSam\n\n${fileInstructions([])}`);
  });
});

describe('buildMessages with files', () => {
  const f = (name: string, body: string) => `<file name="${name}">\n${body}\n</file>`;
  const path = [
    { role: 'user' as const, content: 'make a page' },
    { role: 'assistant' as const, content: f('p.html', 'old') },
    { role: 'user' as const, content: 'blue' },
    { role: 'assistant' as const, content: f('p.html', 'new') },
  ];

  it('adds the file section and collapses superseded versions', () => {
    const out = buildMessages(empty, path, undefined, { imageNames: ['beach.jpg'] });
    expect(out[0]).toEqual({ role: 'system', content: fileInstructions(['beach.jpg']) });
    expect(out[2]).toEqual({ role: 'assistant', content: '<file name="p.html" superseded="true" />' });
    expect(out[4]).toEqual({ role: 'assistant', content: f('p.html', 'new') });
  });

  it('leaves prompts without files alone', () => {
    expect(buildMessages(empty, path)[1]).toEqual({ role: 'assistant', content: f('p.html', 'old') });
  });
});
