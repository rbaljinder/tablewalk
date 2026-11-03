/**
 * The facts that live in the code AND in prose, held together.
 *
 * CLAUDE.md keeps a list titled "facts that are written in more than one place" — the MCP tool count, the CLI flags, the
 * dialects — each with a manual command to verify it, because each has drifted before. A manual ritual is a rule that
 * fails silently on the day it matters; these tests are those rituals, run on every `npm test`. Prose into invariant.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { toolCounts, toolNames } from '../src/server/mcp.js';
import { flagsIn } from './support/flags.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const README = read('README.md');
const PKG = JSON.parse(read('package.json'));
const CLI = read('src/server/cli/usage.ts');
/* tablewalk.dev's pages, which state the same facts to someone who never opens the README. */
const SITE_DOCS = 'site/src/content/docs';
const sitePages = (): string[] => [
  `${SITE_DOCS}/index.mdx`,
  ...readdirSync(new URL(`../${SITE_DOCS}/docs/`, import.meta.url))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${SITE_DOCS}/docs/${name}`),
];
const usageOf = (cli: string): string => {
  const usage = cli.match(/const USAGE = `([\s\S]*?)`/)?.[1];
  assert.ok(usage, 'USAGE moved — update the extraction here');
  return usage;
};

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'twenty-one',
  'twenty-two',
  'twenty-three',
  'twenty-four',
  'twenty-five',
  'twenty-six',
  'twenty-seven',
  'twenty-eight',
  'twenty-nine',
  'thirty',
];

describe('the prose agrees with the code it describes', () => {
  test('current-release prose names the latest completed changelog entry', () => {
    // `npx tablewalk --version` prints the manifest's version (test/cli-version.test.ts); the changelog's newest entry
    // is the release that version names, and no page states "the current release is" by hand to go stale.
    const released = /^## (\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/m.exec(read('CHANGELOG.md'))?.[1];
    assert.ok(released, 'The changelog needs a completed release entry.');
    assert.equal(released, PKG.version, 'CHANGELOG.md: the newest entry is not the manifest version');
    for (const page of [README, ...sitePages().map(read)]) assert.doesNotMatch(page, /current release is/i);
  });

  test('the MCP tool count in the README is the real one', () => {
    const { read: reading, write } = toolCounts();
    const total = reading + write;
    assert.ok(total >= 20 && total <= 30, `spell out ${total} by hand and widen WORDS`);
    const capitalised = WORDS[total][0].toUpperCase() + WORDS[total].slice(1);
    assert.ok(
      README.includes(`**${capitalised} tools**`),
      `README says a different number than the ${total} tools the server defines — update the "${capitalised} tools" sentence`,
    );
  });

  test('the README says the read/write split the server actually has, and names every tool', () => {
    const { read: reading, write } = toolCounts();
    assert.match(
      README,
      new RegExp(`${WORDS[reading]} read-only, and ${WORDS[write]} writes`),
      `README should say ${WORDS[reading]} read-only, ${WORDS[write]} writes`,
    );
    for (const name of toolNames()) assert.ok(README.includes(`\`${name}\``), `README's tool tables do not mention \`${name}\``);
  });

  test("every flag in tablewalk's USAGE is in the README Options block, and none is made up there", () => {
    const options = README.match(/## Options\n\n```([\s\S]*?)```/)?.[1];
    assert.ok(options, 'the README Options block moved — update the extraction here');
    const fromUsage = flagsIn(usageOf(CLI));
    const fromReadme = flagsIn(options);
    for (const flag of fromUsage) assert.ok(fromReadme.has(flag), `USAGE has ${flag}; the README Options block does not`);
    for (const flag of fromReadme) assert.ok(fromUsage.has(flag), `the README Options block has ${flag}; USAGE does not`);
  });

  /* The README is read in two places that do not hold the repository: on npm, and in node_modules/tablewalk. A relative
     link to docs/ worked on GitHub and nowhere a package reader was, so a link either lands inside what `files` ships or
     is a full URL. */
  test('every relative link in the README lands inside the published package', () => {
    const shipped: string[] = PKG.files;
    const relative = [...README.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(https?:|mailto:|#)/.test(target));
    for (const target of relative) {
      const path = target.split('#')[0];
      assert.ok(
        shipped.some((entry) => path === entry || path.startsWith(`${entry}/`)),
        `the README links to ${target}, which the package does not ship; link the site or GitHub`,
      );
    }
  });

  /* A document that offers a flag the CLI does not take is describing a tablewalk that is not this one. Only what a line
     offers *after* naming the command: a design token is spelled `--surface` and Docker takes `--rm`; neither is a claim
     about this CLI. */
  test('every flag named in the docs is one the CLI takes', () => {
    const real = new Set([...usageOf(CLI).matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]));
    const offered = (text: string): string[] =>
      text.split('\n').flatMap((line) => {
        const at = line.search(/tablewalk/);
        if (at < 0) return [];
        return [...line.slice(at).matchAll(/(?<=\s)--[a-z][a-z-]+/g)].map((match) => match[0]);
      });
    /* A flag a document offers on purpose because it is *not* one: the README shows `tablewalk --prot 4111` to say that an
       unrecognised option is an error rather than a shrug. */
    const DELIBERATE = new Set(['--prot']);
    const problems: string[] = [];
    for (const file of ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'docs/deploy.md', ...sitePages()]) {
      for (const flag of offered(read(file)))
        if (!real.has(flag) && !DELIBERATE.has(flag)) problems.push(`${file} offers ${flag} to tablewalk, which the CLI does not take.`);
    }
    assert.deepEqual([...new Set(problems)], [], 'Prose that names a flag the CLI does not take describes a tablewalk this is not.');
  });

  /* The site's MCP page is the one a reader of tablewalk.dev trusts for the tool list, so it is held to the server the
     way the README is: the count in words, the read/write split, and every tool by name. The home page repeats the count. */
  test("the site's MCP page states the real tool count and split, and names every tool", () => {
    const { read: reading, write } = toolCounts();
    const total = reading + write;
    const mcp = read(`${SITE_DOCS}/docs/mcp.md`);
    const capitalised = WORDS[total][0].toUpperCase() + WORDS[total].slice(1);
    assert.match(
      mcp,
      new RegExp(`${capitalised} tools: ${WORDS[reading]} read-only, and ${WORDS[write]} writes`),
      `site/…/mcp.md should say "${capitalised} tools: ${WORDS[reading]} read-only, and ${WORDS[write]} writes"`,
    );
    assert.ok(read(`${SITE_DOCS}/index.mdx`).includes(`${WORDS[total]} tools`), `the site's home page should say ${WORDS[total]} tools`);
    for (const name of toolNames()) assert.ok(mcp.includes(`| \`${name}\` |`), `the site's MCP page has no row for \`${name}\``);
  });

  test("every flag in tablewalk's USAGE is on the site's CLI page, and none is made up there", () => {
    /* `--prot` is the CLI page's example of an option tablewalk refuses. */
    const page = flagsIn(read(`${SITE_DOCS}/docs/cli.md`));
    page.delete('--prot');
    const fromUsage = flagsIn(usageOf(CLI));
    for (const flag of fromUsage) assert.ok(page.has(flag), `USAGE has ${flag}; the site's CLI page does not`);
    for (const flag of page) assert.ok(fromUsage.has(flag), `the site's CLI page has ${flag}; USAGE does not`);
  });

  test('the dialects are stated wherever they are stated', () => {
    for (const dialect of ['sqlite', 'postgres']) {
      assert.ok(
        (PKG.keywords as string[]).some((k) => k.includes(dialect)),
        `package.json keywords do not mention ${dialect}`,
      );
      assert.match(README.toLowerCase(), new RegExp(dialect), `README does not mention ${dialect}`);
    }
  });

  /* The author is in the United States and the docs say so: color, not colour. The list is words the docs have actually
     drifted to, plus their obvious siblings; add one when a new drift turns up. */
  test('the README and the docs use American spellings', () => {
    const UK =
      /\b(colour\w*|centred|centres?|licence\w*|behaviour\w*|organis\w+|favour\w*|honour\w*|neighbour\w*|greys?|catalogues?|analyse[sd]?|initialis\w+|recognis\w+|customis\w+|optimis\w+|minimis\w+|normalis\w+|summaris\w+|synchronis\w+|authoris\w+|serialis\w+|visualis\w+|utilis\w+|prioritis\w+|labell\w+|modell\w+|defence|artefacts?|judgement|enquir\w+|whilst|amongst|programmes?)\b/gi;
    const found: string[] = [];
    const docs = readdirSync(new URL('../docs/', import.meta.url)).filter((name) => name.endsWith('.md'));
    for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md', ...docs.map((doc) => `docs/${doc}`), ...sitePages()])
      for (const hit of read(name).matchAll(UK)) found.push(`${name}: ${hit[0]}`);
    assert.deepEqual([...new Set(found)], [], 'Use American English in the docs: color, centered, license, behavior, organize.');
  });

  test('the short help names every command its USAGE names, and spells only flags its USAGE has', () => {
    const usage = usageOf(CLI);
    const short = CLI.match(/const SHORT_USAGE = `([\s\S]*?)`/)?.[1];
    assert.ok(short, 'SHORT_USAGE moved — update the extraction here');
    const commands = [...new Set([...usage.matchAll(/^ {2}tablewalk ([a-z][a-z-]*)(?=\s|$)/gm)].map((match) => match[1]))];
    for (const command of commands)
      assert.match(short, new RegExp(`(tablewalk |[ ,])${command}\\b`), `USAGE has tablewalk ${command}; the short help does not`);
    const flags = flagsIn(usage);
    for (const flag of flagsIn(short)) assert.ok(flags.has(flag), `the short help has ${flag}; USAGE does not`);
  });
});
