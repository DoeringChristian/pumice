import { describe, expect, it } from 'vitest';
import { attachmentName, folderFor, ruleFromObsidian } from '../src/locations';

describe('file locations', () => {
  it('resolves folder rules relative to the note', () => {
    expect(folderFor({ mode: 'root', folder: '' }, 'a/b/Note.md')).toBe('');
    expect(folderFor({ mode: 'folder', folder: 'assets' }, 'a/b/Note.md')).toBe('assets');
    expect(folderFor({ mode: 'same', folder: '' }, 'a/b/Note.md')).toBe('a/b');
    expect(folderFor({ mode: 'subfolder', folder: 'media' }, 'a/b/Note.md')).toBe('a/b/media');
    expect(folderFor({ mode: 'subfolder', folder: 'media' }, 'Note.md')).toBe('media');
    expect(folderFor({ mode: 'same', folder: '' }, undefined)).toBe('');
  });

  it("reads Obsidian's attachment folder setting", () => {
    expect(ruleFromObsidian('assets')).toEqual({ mode: 'folder', folder: 'assets' });
    expect(ruleFromObsidian('/')).toEqual({ mode: 'root', folder: '' });
    expect(ruleFromObsidian('./')).toEqual({ mode: 'same', folder: '' });
    expect(ruleFromObsidian('./attachments')).toEqual({ mode: 'subfolder', folder: 'attachments' });
    expect(ruleFromObsidian(undefined)).toBeUndefined();
  });

  it('names pasted and dropped files', () => {
    const now = new Date('2026-11-20T14:30:05Z');
    expect(attachmentName({ name: 'image.png', type: 'image/png' }, now)).toEqual({
      base: 'pasted-image-20261120143005',
      extension: 'png',
    });
    expect(attachmentName({ name: 'Figure 3: setup.JPG', type: 'image/jpeg' }, now)).toEqual({
      base: 'Figure 3- setup',
      extension: 'jpg',
    });
    expect(attachmentName({ name: 'paper.pdf', type: '' }, now)).toEqual({
      base: 'paper',
      extension: 'pdf',
    });
  });
});
