import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsOnScreen, applyRules } from '../src/extract.mjs';

// A trimmed copy of the Google Maps results screen recorded on 2026-10-08.
const node = (id, bounds, extra = {}) => ({ id, text: '', desc: '', resourceId: '', clickable: false, scrollable: false, editable: false, bounds, ...extra });
const nodes = [
  node(0, [0, 0, 1080, 2340], { scrollable: true }),
  node(1, [0, 660, 890, 829], { clickable: true }),
  node(2, [0, 721, 176, 796], { text: 'pizza' }),
  node(3, [0, 829, 1080, 2340], { scrollable: true, resourceId: 'maps:id/search_list_layout' }),
  node(4, [0, 964, 1080, 2010], { clickable: true }),
  node(5, [56, 987, 1024, 1038], { desc: 'Sponsored, About this ad' }),
  node(6, [56, 1049, 529, 1103], { desc: 'Jack & Berry Pizza Burger' }),
  node(7, [56, 1103, 219, 1148], { desc: '4,9 stars, 326 ratings' }),
  node(8, [488, 1103, 578, 1148], { desc: '1,6 km' }),
  node(9, [0, 2033, 1080, 2330], { clickable: true }),
  node(10, [56, 2118, 577, 2172], { desc: 'Pizza A7' }),
  node(11, [56, 2172, 226, 2217], { desc: '4,0 stars, 125 ratings' }),
  node(12, [388, 2217, 459, 2262], { desc: '280 m' }),
];

test('the results list wins over the full-screen scroll view', () => {
  const { list, rows } = rowsOnScreen(nodes);
  assert.equal(list.resourceId, 'maps:id/search_list_layout');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['Pizza A7', '4,0 stars, 125 ratings', '280 m']);
});

test('rules turn a row into a record', () => {
  const rules = {
    fields: [{ name: 'name', index: 0 }, { name: 'rating', regex: '^(\\d,\\d) stars' }, { name: 'reviews', regex: '([\\d\\s]+) ratings' }, { name: 'distance', regex: '^([\\d,]+ ?k?m)$' }],
    ignore: ['^Sponsored'], key: 'name',
  };
  const { rows } = rowsOnScreen(nodes);
  assert.deepEqual(applyRules(rules, rows[0]), { name: 'Jack & Berry Pizza Burger', rating: '4,9', reviews: '326', distance: '1,6 km' });
});
