/**
 * The server a test stands up: the database browser's (http/browserServer.ts), the one this package serves.
 */
export { createBrowserApp as createApp } from '../../src/server/http/browserServer.js';
export { commandOperations } from '@mistriwork/engine/server/http/serverCore.js';
