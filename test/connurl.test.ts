/**
 * A connection string and its parts: the connection dialog's URL parser (client/connurl.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PORTS,
  buildConnectionUrl,
  isEnvReference,
  looksSchemeless,
  parseConnectionUrl,
  redactConnectionUrl,
} from '../src/client/connurl.js';

describe('a connection string and its parts', () => {
  /* The dialog offers both a URL box and a set of fields, and they have to be
     the same thing rather than two forms that disagree. The fiddly half is
     percent-encoding, which is where a password containing `@` becomes a
     connection to a host that does not exist. */

  const roundTrip = (url: string) => buildConnectionUrl(parseConnectionUrl(url));

  describe('a URL with its scheme missing', () => {
    /* The name tablewalk prints for a connection is its public URL form, so
       copying that and pasting it back is an ordinary thing to do — and with
       no `://` it lands in the file-path branch and fails with SQLite's
       "unable to open database file". */
    test('is spotted by the user@host that no file path has', () => {
      assert.equal(looksSchemeless('postgres@127.0.0.1/tablewalk'), true);
      assert.equal(looksSchemeless('root@127.0.0.1:3306/db'), true);
      assert.equal(looksSchemeless('user@host'), true);
    });

    test('and a real file path is left alone', () => {
      /* The whole risk of the check: a false positive here turns a working
         SQLite path into a warning telling somebody to break it. */
      assert.equal(looksSchemeless('./data/app.db'), false);
      assert.equal(looksSchemeless('/Users/dev/x.db'), false);
      assert.equal(looksSchemeless('C:/db/app.db'), false);
      assert.equal(looksSchemeless('app.db'), false);
      assert.equal(looksSchemeless(''), false);
    });

    test('and so is a URL that already has one', () => {
      assert.equal(looksSchemeless('postgres://a@b/c'), false);
      assert.equal(looksSchemeless('sqlite:///tmp/x.db'), false);
    });
  });

  test('an ordinary URL survives being taken apart and put back', () => {
    for (const url of ['postgres://app@db.internal/appdb', 'postgres://app:secret@db.internal:6543/appdb']) {
      assert.equal(roundTrip(url), url, url);
    }
  });

  test('a password with punctuation in it survives, which is the whole point', () => {
    /* Written straight into a template string, `p@ss:word` names the host
       `word@db.internal` and the failure reads as "could not connect" rather
       than "your password has an @ in it". */
    const parts = parseConnectionUrl('postgres://app:p%40ss%3Aword@db.internal/appdb');
    assert.equal(parts.password, 'p@ss:word');
    const rebuilt = buildConnectionUrl(parts);
    assert.equal(new URL(rebuilt).hostname, 'db.internal');
    assert.equal(decodeURIComponent(new URL(rebuilt).password), 'p@ss:word');
  });

  test('a default port is not shown, and not written back', () => {
    /* A port box reading 5432 on every Postgres connection is a box nobody
       reads, and one that has to be cleared to mean "the default". */
    assert.equal(parseConnectionUrl('postgres://app@db/appdb').port, '');
    assert.equal(parseConnectionUrl(`postgres://app@db:${DEFAULT_PORTS.postgres}/appdb`).port, '');
    assert.equal(parseConnectionUrl('postgres://app@db:6543/appdb').port, '6543');
    assert.equal(buildConnectionUrl({ driver: 'postgres', host: 'db', database: 'appdb' }), 'postgres://db/appdb');
  });

  test('query parameters are kept whole', () => {
    /* `?sslmode=require` is not decoration: losing it on a round trip through
       a form turns a verified connection into a plaintext one, silently. */
    const url = 'postgres://app@db/appdb?sslmode=require&application_name=tablewalk';
    assert.equal(parseConnectionUrl(url).params, 'sslmode=require&application_name=tablewalk');
    assert.equal(roundTrip(url), url);
  });

  test('a file path is a file path, not a URL with empty parts', () => {
    const parts = parseConnectionUrl('/var/data/app.sqlite');
    assert.equal(parts.driver, 'sqlite');
    assert.equal(parts.file, '/var/data/app.sqlite');
    assert.equal(parts.host, '', 'a file has no host to invent');
    assert.equal(roundTrip('/var/data/app.sqlite'), '/var/data/app.sqlite');
    assert.equal(parseConnectionUrl('sqlite:///var/data/app.sqlite').file, '/var/data/app.sqlite');
  });

  test('half a URL is the normal state of a box being typed in, not an error', () => {
    for (const partial of ['', 'postgres://', 'post', 'postgres://@']) {
      assert.doesNotThrow(() => parseConnectionUrl(partial), partial);
    }
    // And a set of parts with no host yet builds nothing rather than nonsense.
    assert.equal(buildConnectionUrl({ driver: 'postgres', host: '', database: 'appdb' }), '');
  });

  test('an environment reference survives the form that was meant to support it', () => {
    /* The arrangement the documentation recommends *first*, and the one the
       form quietly destroyed: `encodeURIComponent('${PROD_PASSWORD}')` is
       `%24%7BPROD_PASSWORD%7D`, which `expandEnv` does not match — so typing
       a reference into the password box produced a connection whose password
       was the literal characters of the reference, with nothing on screen to
       say so. */
    for (const password of ['${PROD_PASSWORD}', '$PGPASS']) {
      const url = buildConnectionUrl({ driver: 'postgres', host: 'db', database: 'appdb', user: 'app', password });
      assert.ok(url.includes(password), url);
      assert.ok(!url.includes('%24'), url);
    }

    /* Part literal, part reference — which people write — encodes the half
       that needs it and leaves the half that must not be touched. */
    const mixed = buildConnectionUrl({ driver: 'postgres', host: 'db', database: 'appdb', user: 'app', password: 'pre@fix-${TOKEN}' });
    assert.ok(mixed.includes('${TOKEN}'), mixed);
    assert.ok(mixed.includes('%40'), 'and the @ beside it is still encoded');

    // A password that merely looks like money is not a reference.
    assert.equal(isEnvReference('$100 and up'), false);
    assert.equal(isEnvReference('p@ss:word'), false);
    assert.equal(isEnvReference('${PROD_PASSWORD}'), true);
  });

  test('the preview shows a reference and hides a secret', () => {
    /* A reference names a variable and reveals nothing, and it is the part
       worth reading back carefully — dotting it out would remove the only way
       to notice the variable name is misspelled. */
    assert.equal(redactConnectionUrl('postgres://app:${PROD_PASSWORD}@db/appdb'), 'postgres://app:${PROD_PASSWORD}@db/appdb');
    assert.ok(!redactConnectionUrl('postgres://app:hunter2@db/appdb').includes('hunter2'));
  });

  test('the preview hides the password without hiding the rest', () => {
    const shown = redactConnectionUrl('postgres://app:hunter2@db.internal:6543/appdb');
    assert.ok(!shown.includes('hunter2'), shown);
    assert.ok(shown.includes('app'), 'the user is still legible');
    assert.ok(shown.includes('db.internal:6543'), 'and so is where it goes');
    assert.ok(shown.includes('••••'), shown);
    // Nothing to hide, nothing changed.
    assert.equal(redactConnectionUrl('postgres://app@db/appdb'), 'postgres://app@db/appdb');
    assert.equal(redactConnectionUrl('/var/data/app.sqlite'), '/var/data/app.sqlite');
  });
});
