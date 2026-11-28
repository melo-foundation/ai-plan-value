#!/usr/bin/env node
/**
 * Stand-in for `bl` and `deeprelay` in the run tests: prints the fake provider's meter JSON for
 * FAKE_CLI_KIND (bailian | deeprelay) from http://127.0.0.1:$FAKE_PORT/__cli/<kind>. Checks the
 * arguments the kit passes. Makes no outside call.
 */

const kind = process.env.FAKE_CLI_KIND;
const want = { bailian: "usage token-plan --output json", deeprelay: "billing subscription -o json" }[kind];
if (process.argv.slice(2).join(" ") !== want) {
  console.error(`fake-cli: unexpected arguments ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
const res = await fetch(`http://127.0.0.1:${process.env.FAKE_PORT}/__cli/${kind}`);
process.stdout.write(await res.text());
