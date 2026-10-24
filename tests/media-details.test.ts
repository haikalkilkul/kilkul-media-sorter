import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaDetails } from '../src/components/MediaDetails';
import type { MediaItem } from '../src/services/api';

const item = (relativePath: string, filename: string): MediaItem => ({
  id: '0123456789abcdef0123456789abcdef',
  filename,
  mediaType: 'video',
  sizeBytes: 2_726_298,
  relativePath,
  extension: '.mp4',
});

describe('central media details', () => {
  it('renders the actual nested relative path beneath metadata and normalizes separators', () => {
    const markup = renderToStaticMarkup(createElement(MediaDetails, { item: item('Vacation\\New Salsa (1).mp4', 'New Salsa (1).mp4') }));
    assert.match(markup, /New Salsa \(1\)\.mp4/);
    assert.match(markup, /VIDEO/);
    assert.match(markup, /2\.60 MB/);
    assert.match(markup, /Source: Vacation\/New Salsa \(1\)\.mp4/);
    assert.match(markup, /title="Vacation\/New Salsa \(1\)\.mp4"/);
  });

  it('shows a root-level filename as its relative source path and follows the current item prop', () => {
    const rootMarkup = renderToStaticMarkup(createElement(MediaDetails, { item: item('photo.jpg', 'photo.jpg') }));
    assert.match(rootMarkup, /Source: photo\.jpg/);
    const nextMarkup = renderToStaticMarkup(createElement(MediaDetails, { item: item('Events\\photo.jpg', 'photo.jpg') }));
    assert.match(nextMarkup, /Source: Events\/photo\.jpg/);
  });
});
