/**
 * The shell's answers a page's boot names (workbench.js installs them), read from the modules those answers come from,
 * for a component test that drives Undo or the page builder through those modules, or a mock of them, as the page
 * does: `beforeEach(bridgeShell)`.
 *
 * Called in the test's own hook, after its vi.mock calls, so a mock is what is read; an export a mock leaves out keeps
 * the default answer. Not in the setup file: importing these modules there, ahead of a test that resets the module
 * graph (vi.resetModules), leaves that test two session identities.
 */
import { installShell } from '@mistriwork/kit/client/shellMode.js';

export async function bridgeShell(): Promise<void> {
  /* A module whose own imports a test mocked away cannot load; its answers stay the default. */
  const load = <T>(module: Promise<T>) => module.catch(() => undefined);
  const [undo, pageBuilder] = await Promise.all([load(import('../src/client/undo.js')), load(import('../src/client/pagebuilder.js'))]);
  /* A mock's missing export throws when read. */
  const has = (module: object | undefined, name: string) => {
    try {
      return module !== undefined && (module as Record<string, unknown>)[name] != null;
    } catch {
      return false;
    }
  };
  const answers: Parameters<typeof installShell>[0] = {};
  answers.undo = {
    refresh: () => (has(undo, 'refreshUndo') ? undo!.refreshUndo() : undefined),
    last: (id) => (has(undo, 'undoLast') ? undo!.undoLast(id as never) : undefined),
    toast: (id, after) => (has(undo, 'undoToast') ? undo!.undoToast(id, after) : undefined),
  };
  /* The Workbench's page builder (workbench.js installs it), read through the module so a mock of it is what opens. */
  if (has(pageBuilder, 'openBuilder')) answers.editPage = (page, options) => void pageBuilder!.openBuilder(page as never, options);
  installShell(answers);
}
