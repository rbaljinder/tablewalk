/**
 * The database picker in the top bar: which connection is open, the others
 * a click away, re-introspection as the one action, and the cog beside it
 * that opens Connections — a destination, not a variation on the thing
 * above it.
 */
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import type { EnvironmentTier, SiblingEnvironment } from '../../shared/environments.js';
import { say } from '../copy/workbench/components/ConnectionPicker.js';

const PIPELINE = ['local', 'dev', 'test', 'staging', 'replica', 'prod', 'other'];

export interface PickerConnection {
  id: string;
  name: string;
  detail?: string;
  dialect?: string;
  error?: string;
  connected?: boolean;
  writable?: boolean;
  rows?: boolean;
  hidesColumns?: boolean;
  redactsRows?: boolean;
  maxRows?: number;
  database?: string;
  env?: string;
  tier?: EnvironmentTier;
  explicit?: boolean;
  siblings?: SiblingEnvironment[];
}

function postureShort(conn: { writable?: boolean; rows?: boolean; redactsRows?: boolean }): string {
  if (conn.rows === false) return say('postureShape');
  if (conn.writable) return say('postureRw');
  if (conn.redactsRows) return say('postureMasked');
  return say('postureRo');
}

export function ConnectionPicker({
  connections,
  active,
  onSelect,
  onSelectSibling,
  onReintrospect,
  onManage,
}: {
  connections: PickerConnection[];
  active: string;
  onSelect: (id: string) => void;
  onSelectSibling?: (id: string) => void;
  onReintrospect: () => void;
  onManage: () => void;
}) {
  const activeConn = connections.find((c) => c.id === active);
  const activeDb = (activeConn?.database ?? activeConn?.name ?? '').toLowerCase();
  const groupEnvs = activeConn
    ? connections
        .filter((c) => (c.database ?? c.name).toLowerCase() === activeDb)
        .sort((a, b) => PIPELINE.indexOf(a.tier ?? 'other') - PIPELINE.indexOf(b.tier ?? 'other'))
    : [];
  const switchSibling = onSelectSibling ?? onSelect;

  return (
    <>
      <Dropdown
        ariaLabel={say('databaseConnection')}
        value={active}
        items={connections.map((conn) => ({
          value: conn.id,
          label: conn.name,
          detail: conn.error ? say('unreachableDetail', { detail: conn.detail ?? '' }) : conn.detail,
          badge: conn.env ? `${conn.env}${conn.dialect ? ` · ${conn.dialect}` : ''}` : conn.dialect,
          tone: conn.error ? 'critical' : undefined,
        }))}
        onValueChange={(id) => {
          const picked = connections.find((c) => c.id === id);
          if (activeConn && picked && (picked.database ?? picked.name).toLowerCase() === activeDb) switchSibling(id);
          else onSelect(id);
        }}
        actions={[{ label: say('reReadTheSchema'), onSelect: onReintrospect }]}
      />
      {activeConn && groupEnvs.length > 1 ? (
        <div
          className="conn-env-bar"
          role="group"
          aria-label={say('environmentGroup', { database: activeConn.database ?? activeConn.name })}
        >
          {groupEnvs.map((envConn) => {
            const current = envConn.id === active;
            const posture = postureShort(envConn);
            return (
              <button
                key={envConn.id}
                type="button"
                className={`env-pill tone-${envConn.tier ?? 'other'}${current ? ' active' : ''}`}
                aria-pressed={current}
                title={say(current ? 'currentEnvironmentTitle' : 'switchEnvironmentTitle', { name: envConn.name, posture })}
                onClick={() => {
                  if (!current) switchSibling(envConn.id);
                }}
              >
                <span className="env-pill-dot" aria-hidden="true" />
                <span className="env-pill-label">{envConn.env ?? envConn.name}</span>
                {current ? <span className="env-pill-mode">{posture}</span> : null}
              </button>
            );
          })}
        </div>
      ) : activeConn && (activeConn.tier === 'prod' || activeConn.tier === 'staging' || Boolean(activeConn.explicit && activeConn.env)) ? (
        <span
          className={`env-pill active tone-${activeConn.tier ?? 'other'}`}
          title={say('currentEnvironmentTitle', { name: activeConn.name, posture: postureShort(activeConn) })}
        >
          <span className="env-pill-dot" aria-hidden="true" />
          <span className="env-pill-label">{activeConn.env ?? activeConn.tier}</span>
          <span className="env-pill-mode">{postureShort(activeConn)}</span>
        </span>
      ) : null}
      <button
        type="button"
        className="conn-manage"
        title={say('manageConnections')}
        aria-label={say('manageConnections')}
        onClick={onManage}
      >
        {/* A cog with teeth, not a circle with spokes: the first draft read as a brightness control. */}
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </>
  );
}
