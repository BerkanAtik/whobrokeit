import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UserError } from './errors.js';

/**
 * Builds a small repo with a realistic history: 24 commits of a shopping-cart
 * library by four people. One innocent-looking refactor breaks quantities,
 * and the existing tests don't notice because they only ever use qty 1.
 */

export const DEMO_REPRO = 'repro.test.mjs';
export const DEMO_TEST = `node --test ${DEMO_REPRO}`;
export const DEMO_BUG_REPORT = 'Adding 3 mugs costs the same as 1 mug.';

const REPRO_SOURCE = `// Bug report: "${DEMO_BUG_REPORT}"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, subtotal } from './src/cart.js';

test('subtotal counts quantity', () => {
  const cart = createCart();
  addItem(cart, { name: 'mug', price: 9.99, qty: 3 });
  assert.equal(subtotal(cart), 29.97);
});
`;

interface State {
  remove: boolean;
  discount: boolean;
  tax: boolean;
  format: boolean;
  currency: boolean;
  shipping: boolean;
  round2: boolean;
  coupons: boolean;
  bug: boolean;
  limits: boolean;
  typoFixed: boolean;
  summary: boolean;
  tests: Set<string>;
  readme: number;
  changelog: number;
  editorconfig: boolean;
  apiDocs: boolean;
  version: string;
}

const PEOPLE = {
  ana: ['Ana Rivera', 'ana@example.com'],
  ben: ['Ben Okafor', 'ben@example.com'],
  mira: ['Mira Patel', 'mira@example.com'],
  kai: ['Kai Novak', 'kai@example.com'],
} as const;

const HISTORY: Array<[keyof typeof PEOPLE, string, (s: State) => void]> = [
  ['ana', 'init: tiny-cart skeleton', () => {}],
  ['ana', 'test: cover subtotal', (s) => void s.tests.add('subtotal')],
  ['ben', 'feat: remove items from cart', (s) => void (s.remove = true)],
  ['ana', 'docs: add usage example', (s) => void (s.readme = 2)],
  ['mira', 'feat: percentage discounts', (s) => void (s.discount = true)],
  ['mira', 'test: discount cases', (s) => void s.tests.add('discount')],
  ['ben', 'feat: tax rates', (s) => void (s.tax = true)],
  ['kai', 'chore: add editorconfig', (s) => void (s.editorconfig = true)],
  ['ana', 'feat: formatPrice helper', (s) => void (s.format = true)],
  ['ben', 'test: tax after discount', (s) => void s.tests.add('tax')],
  ['mira', 'docs: start a changelog', (s) => void (s.changelog = 1)],
  ['kai', 'feat: shipping cost helper', (s) => void (s.shipping = true)],
  ['ana', 'refactor: extract round2 helper', (s) => void (s.round2 = true)],
  ['mira', 'feat: coupon codes', (s) => void (s.coupons = true)],
  ['kai', 'refactor: simplify subtotal with reduce', (s) => void (s.bug = true)],
  ['mira', 'test: coupon cases', (s) => void s.tests.add('coupon')],
  ['ben', 'feat: limit quantity per item', (s) => void (s.limits = true)],
  ['ana', 'docs: api reference', (s) => void (s.apiDocs = true)],
  ['ben', 'fix: typo in quantity error', (s) => void (s.typoFixed = true)],
  ['kai', 'feat: currency option for formatPrice', (s) => void (s.currency = true)],
  ['ana', 'chore: release 0.4.0', (s) => void Object.assign(s, { version: '0.4.0', changelog: 2 })],
  ['mira', 'test: shipping threshold', (s) => void s.tests.add('shipping')],
  ['ben', 'feat: cart summary', (s) => void (s.summary = true)],
  ['ana', 'docs: badges in readme', (s) => void (s.readme = 3)],
];

export async function createDemoRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) throw new UserError(`${dir} is not empty.`);

  await gitIn(dir, ['init', '-q', '-b', 'main']);
  await gitIn(dir, ['config', 'core.autocrlf', 'false']);
  await gitIn(dir, ['config', 'commit.gpgsign', 'false']);

  const state: State = {
    remove: false,
    discount: false,
    tax: false,
    format: false,
    currency: false,
    shipping: false,
    round2: false,
    coupons: false,
    bug: false,
    limits: false,
    typoFixed: false,
    summary: false,
    tests: new Set(),
    readme: 1,
    changelog: 0,
    editorconfig: false,
    apiDocs: false,
    version: '0.3.0',
  };

  const day = 86_400_000;
  const start = Date.now() - 30 * day;
  for (const [i, [who, message, change]] of HISTORY.entries()) {
    change(state);
    for (const [path, content] of Object.entries(files(state))) {
      if (content === null) continue;
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const [name, email] = PEOPLE[who];
    const date = new Date(start + i * 1.2 * day + (i % 5) * 3_600_000).toISOString();
    await gitIn(dir, ['add', '-A']);
    await gitIn(dir, ['commit', '-q', '--no-verify', '-m', message], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    });
  }

  await writeFile(join(dir, DEMO_REPRO), REPRO_SOURCE);
}

function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, ...env }, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      else resolve();
    });
  });
}

function files(s: State): Record<string, string | null> {
  return {
    'package.json': `${JSON.stringify(
      { name: 'tiny-cart', version: s.version, type: 'module', scripts: { test: 'node --test test/' } },
      null,
      2,
    )}\n`,
    'README.md': readme(s),
    'src/cart.js': cart(s),
    'test/cart.test.mjs': s.tests.size > 0 ? tests(s) : null,
    'CHANGELOG.md': s.changelog > 0 ? changelog(s) : null,
    '.editorconfig': s.editorconfig
      ? 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\nend_of_line = lf\ninsert_final_newline = true\n'
      : null,
    'docs/api.md': s.apiDocs ? API_DOCS : null,
  };
}

function readme(s: State): string {
  const badges =
    s.readme >= 3
      ? `\n![version](https://img.shields.io/badge/version-${s.version}-blue) ![license](https://img.shields.io/badge/license-MIT-green)\n`
      : '';
  let text = `# tiny-cart\n${badges}\nA tiny shopping cart library.\n`;
  if (s.readme >= 2) {
    text +=
      "\n## Usage\n\n```js\nimport { createCart, addItem, subtotal } from 'tiny-cart';\n\n" +
      "const cart = createCart();\naddItem(cart, { name: 'mug', price: 9.99, qty: 2 });\nsubtotal(cart); // 19.98\n```\n";
  }
  return text;
}

function changelog(s: State): string {
  const older = '## 0.3.0\n\n- Discounts, tax rates and price formatting.\n';
  const newer = '## 0.4.0\n\n- Coupon codes, quantity limits and currency formatting.\n\n';
  return `# Changelog\n\n${s.changelog >= 2 ? newer : ''}${older}`;
}

const API_DOCS = `# API

- \`createCart(options?)\` creates an empty cart. \`options.taxRate\` defaults to 0.
- \`addItem(cart, { name, price, qty })\` adds an item. \`qty\` defaults to 1.
- \`removeItem(cart, name)\` removes every item with that name.
- \`subtotal(cart)\` is the sum of price times quantity.
- \`applyDiscount(cart, pct)\` and \`applyCoupon(cart, code)\` set a discount.
- \`total(cart)\` is the subtotal after discount and tax.
- \`shippingFor(cart)\` is free from 50, otherwise 4.99.
- \`formatPrice(amount, currency?)\` formats a price.
`;

function cart(s: State): string {
  const round = (expr: string, compound = false): string =>
    s.round2 ? `round2(${expr})` : `Math.round(${compound ? `(${expr})` : expr} * 100) / 100`;
  const out: string[] = [];

  if (s.limits) out.push('const MAX_QTY = 99;');
  if (s.coupons) out.push('const COUPONS = { SAVE10: 10, SAVE20: 20 };');
  if (s.round2) out.push('function round2(n) {\n  return Math.round(n * 100) / 100;\n}');

  out.push('export function createCart(options = {}) {\n  return { items: [], discountPct: 0, taxRate: options.taxRate ?? 0 };\n}');

  const guard = s.limits
    ? `  if (qty < 1 || qty > MAX_QTY) {\n    throw new RangeError('${s.typoFixed ? 'Quantity' : 'Quantitiy'} must be between 1 and ' + MAX_QTY);\n  }\n`
    : '';
  out.push(`export function addItem(cart, { name, price, qty = 1 }) {\n${guard}  cart.items.push({ name, price, qty });\n  return cart;\n}`);

  if (s.remove) {
    out.push('export function removeItem(cart, name) {\n  cart.items = cart.items.filter((item) => item.name !== name);\n  return cart;\n}');
  }

  out.push(
    s.bug
      ? 'export function subtotal(cart) {\n  return round2(cart.items.reduce((sum, item) => sum + item.price, 0));\n}'
      : `export function subtotal(cart) {\n  let sum = 0;\n  for (const item of cart.items) {\n    sum += item.price * item.qty;\n  }\n  return ${round('sum')};\n}`,
  );

  if (s.discount) {
    out.push(
      "export function applyDiscount(cart, pct) {\n  if (pct < 0 || pct > 100) {\n    throw new RangeError('Discount must be between 0 and 100');\n  }\n  cart.discountPct = pct;\n  return cart;\n}",
    );
    if (s.coupons) {
      out.push(
        "export function applyCoupon(cart, code) {\n  const pct = COUPONS[code.toUpperCase()];\n  if (pct === undefined) {\n    throw new Error('Unknown coupon: ' + code);\n  }\n  return applyDiscount(cart, pct);\n}",
      );
    }
    const taxed = s.tax ? 'afterDiscount * (1 + cart.taxRate)' : 'afterDiscount';
    out.push(
      `export function total(cart) {\n  const afterDiscount = subtotal(cart) * (1 - cart.discountPct / 100);\n  return ${round(taxed, s.tax)};\n}`,
    );
  }

  if (s.shipping) out.push('export function shippingFor(cart) {\n  return subtotal(cart) >= 50 ? 0 : 4.99;\n}');

  if (s.format) {
    out.push(
      s.currency
        ? "export function formatPrice(amount, currency = 'USD') {\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);\n}"
        : "export function formatPrice(amount) {\n  return '$' + amount.toFixed(2);\n}",
    );
  }

  if (s.summary) {
    out.push(
      `export function cartSummary(cart) {\n  const shipping = shippingFor(cart);\n  return {\n    items: cart.items.length,\n    subtotal: subtotal(cart),\n    shipping,\n    total: ${round('total(cart) + shipping', true)},\n  };\n}`,
    );
  }

  return `${out.join('\n\n')}\n`;
}

function tests(s: State): string {
  const names = ['createCart', 'addItem', 'subtotal'];
  if (s.tests.has('discount')) names.push('applyDiscount', 'total');
  if (s.tests.has('coupon')) names.push('applyCoupon');
  if (s.tests.has('shipping')) names.push('shippingFor');

  const out = [
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${names.join(', ')} } from '../src/cart.js';`,
    "test('subtotal adds up item prices', () => {\n  const cart = createCart();\n  addItem(cart, { name: 'pen', price: 2.5 });\n  addItem(cart, { name: 'pad', price: 7.5 });\n  assert.equal(subtotal(cart), 10);\n});",
    "test('empty cart costs nothing', () => {\n  assert.equal(subtotal(createCart()), 0);\n});",
  ];
  if (s.tests.has('discount')) {
    out.push(
      "test('discount reduces the total', () => {\n  const cart = createCart();\n  addItem(cart, { name: 'lamp', price: 50 });\n  applyDiscount(cart, 20);\n  assert.equal(total(cart), 40);\n});",
      "test('discount must be 0-100', () => {\n  assert.throws(() => applyDiscount(createCart(), 120), RangeError);\n});",
    );
  }
  if (s.tests.has('tax')) {
    out.push(
      "test('tax is added after the discount', () => {\n  const cart = createCart({ taxRate: 0.2 });\n  addItem(cart, { name: 'chair', price: 100 });\n  applyDiscount(cart, 10);\n  assert.equal(total(cart), 108);\n});",
    );
  }
  if (s.tests.has('coupon')) {
    out.push(
      "test('coupons are case-insensitive', () => {\n  const cart = createCart();\n  addItem(cart, { name: 'desk', price: 100 });\n  applyCoupon(cart, 'save10');\n  assert.equal(total(cart), 90);\n});",
      "test('unknown coupons are rejected', () => {\n  assert.throws(() => applyCoupon(createCart(), 'FREE'));\n});",
    );
  }
  if (s.tests.has('shipping')) {
    out.push(
      "test('shipping is free from 50', () => {\n  const cart = createCart();\n  addItem(cart, { name: 'rug', price: 60 });\n  assert.equal(shippingFor(cart), 0);\n});",
      "test('shipping costs 4.99 below 50', () => {\n  const cart = createCart();\n  addItem(cart, { name: 'cup', price: 10 });\n  assert.equal(shippingFor(cart), 4.99);\n});",
    );
  }
  return `${out.join('\n\n')}\n`;
}
