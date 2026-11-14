// A stand-in for Claude Code, used by the Action's self-test in CI: it answers the demo repo's
// prompts with a canned test and fix, and checks which credentials reach whom.
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  // The agent gets the AI key, never the GitHub token.
  if (process.env.ANTHROPIC_API_KEY !== 'sk-fake') process.exit(7);
  if (process.env.GITHUB_TOKEN || process.env.WBI_GITHUB_TOKEN) process.exit(8);

  if (prompt.includes('<why>')) {
    process.stdout.write(
      'The reduce drops the quantity.\n<why>subtotal() ignores item.qty.</why>\n<fix>\n<edit path="src/cart.js">\n' +
        '<find>\nsum + item.price, 0\n</find>\n<replace>\nsum + item.price * item.qty, 0\n</replace>\n</edit>\n</fix>\n',
    );
    return;
  }
  // The test it writes must not see the key. If it did, it would fail at every commit and no
  // culprit would be found.
  const code = `import { createCart, addItem, subtotal } from './src/cart.js';
if (process.env.ANTHROPIC_API_KEY) { console.log('WHOBROKEIT_BUG: the test can read the AI key'); process.exit(1); }
const cart = createCart();
addItem(cart, { name: 'mug', price: 9.99, qty: 3 });
const got = subtotal(cart);
if (got !== 29.97) { console.log('WHOBROKEIT_BUG: expected 29.97 for 3 mugs, got ' + got); process.exitCode = 1; }
`;
  process.stdout.write(`<path>whobrokeit-repro.mjs</path>\n<command>node whobrokeit-repro.mjs</command>\n<code>\n${code}</code>\n`);
});
