import { describe, expect, it } from 'vitest';
import { pdfWithoutText, pdfWithText } from '../../test/helpers';
import { insertPending } from '../src/attachments';
import { cleanupPending } from '../src/attachments';
import { cachedPdfText, ensurePdfText, extractPdfText } from '../src/pdfText';
import { makeApp } from './appHelpers';

const addPdf = (db: ReturnType<typeof makeApp>['db'], data: Buffer, filename = 'a.pdf') =>
  insertPending(db, { filename, kind: 'pdf', mime: 'application/pdf', data }).id;
const rows = (db: ReturnType<typeof makeApp>['db']) => (db.prepare('SELECT count(*) AS n FROM pdf_text').get() as { n: number }).n;

describe('extractPdfText', () => {
  it('reads the text of a PDF', async () => {
    expect(await extractPdfText(pdfWithText('Quarterly revenue rose 12%'))).toContain('Quarterly revenue rose 12%');
  });

  it('gives an empty string for a PDF without text or one that does not parse', async () => {
    expect(await extractPdfText(pdfWithoutText())).toBe('');
    expect(await extractPdfText(Buffer.from('%PDF-1.4 garbage'))).toBe('');
  });
});

describe('ensurePdfText', () => {
  it('extracts once and caches', async () => {
    const { db } = makeApp();
    const id = addPdf(db, pdfWithText('Hello cache'));
    expect(cachedPdfText(db, id)).toBeNull();
    await ensurePdfText(db, [id]);
    await ensurePdfText(db, [id]);
    expect(rows(db)).toBe(1);
    expect(cachedPdfText(db, id)).toContain('Hello cache');
  });

  it('shares a row between attachments with the same bytes, and keeps empty results', async () => {
    const { db } = makeApp();
    const data = pdfWithText('Same file');
    const a = addPdf(db, data, 'a.pdf');
    const b = addPdf(db, data, 'b.pdf');
    const empty = addPdf(db, pdfWithoutText(), 'scan.pdf');
    await ensurePdfText(db, [a, b, empty]);
    expect(rows(db)).toBe(2);
    expect(cachedPdfText(db, b)).toContain('Same file');
    expect(cachedPdfText(db, empty)).toBe('');
  });

  it('ignores ids that are not PDFs', async () => {
    const { db } = makeApp();
    const text = insertPending(db, { filename: 't.txt', kind: 'text', mime: 'text/plain', data: new TextEncoder().encode('hi') }).id;
    await ensurePdfText(db, [text, 'missing']);
    expect(rows(db)).toBe(0);
  });
});

describe('cleanupPending', () => {
  it('removes the text of an expired pending PDF, keeping a PDF that is still attached', async () => {
    const { db } = makeApp();
    const id = addPdf(db, pdfWithText('Never sent'));
    await ensurePdfText(db, [id]);
    expect(rows(db)).toBe(1);
    db.prepare('UPDATE attachments SET created_at = 0').run();
    expect(cleanupPending(db)).toBe(1);
    expect(rows(db)).toBe(0);
  });
});
