import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMessageMap,
  buildTabbedSections,
  parseTabPlan
} from '../lib/tab-plan.mjs';

test('parseTabPlan accepts Russian and reversed forms', () => {
  const events = parseTabPlan(
    [
      '4 | вкладка',
      '6 | подзаголовок | Картинки',
      'heading | 8 | Продолжение',
      'tab | 10'
    ].join('\n'),
    12
  );

  assert.deepEqual(events, [
    { type: 'tab', messageNumber: 4, lineNumber: 1 },
    { type: 'heading', messageNumber: 6, title: 'Картинки', lineNumber: 2 },
    { type: 'heading', messageNumber: 8, title: 'Продолжение', lineNumber: 3 },
    { type: 'tab', messageNumber: 10, lineNumber: 4 }
  ]);
});

test('parseTabPlan ignores first-tab marker and duplicate tab boundaries', () => {
  const events = parseTabPlan('1 | вкладка\n3 | вкладка\n3 | tab', 5);
  assert.deepEqual(events, [
    { type: 'tab', messageNumber: 3, lineNumber: 2 }
  ]);
});

test('buildTabbedSections decorates messages with headings and splits ranges', () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    id: String(index + 1),
    role: index % 2 ? 'assistant' : 'user',
    text: 'm' + (index + 1)
  }));
  const events = parseTabPlan(
    '3 | вкладка\n4 | подзаголовок | Тема A\n5 | подзаголовок | Тема B',
    6
  );

  const sections = buildTabbedSections(messages, events);

  assert.equal(sections.length, 2);
  assert.deepEqual(
    sections.map(section => [section.startMessageNumber, section.endMessageNumber]),
    [[1, 2], [3, 6]]
  );
  assert.deepEqual(sections[1].messages[1].archiveHeadings, ['Тема A']);
  assert.deepEqual(sections[1].messages[2].archiveHeadings, ['Тема B']);
});

test('buildMessageMap includes role, number, and image-only marker', () => {
  const map = buildMessageMap([
    { role: 'user', text: 'Привет' },
    { role: 'assistant', text: '', images: [{ src: 'x' }] }
  ]);
  assert.match(map, /^1 · Пользователь · Привет/m);
  assert.match(map, /^2 · ChatGPT · \[изображение\]/m);
});
