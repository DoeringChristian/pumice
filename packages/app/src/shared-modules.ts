/**
 * Libraries shared with community plugins: `pumice-plugin build` turns imports of these into
 * lookups of `globalThis.pumiceModules`, so plugins use the app's single copy (one CodeMirror
 * state, one React, one Yjs) instead of bundling their own.
 */
import * as autocomplete from '@codemirror/autocomplete';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as lezerCommon from '@lezer/common';
import * as lezerHighlight from '@lezer/highlight';
import * as lezerMarkdown from '@lezer/markdown';
import * as api from '@pumice/api';
import * as react from 'react';
import * as reactDom from 'react-dom';
import * as reactDomClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import * as yjs from 'yjs';

export const SHARED_MODULES: Record<string, unknown> = {
  '@pumice/api': api,
  '@codemirror/state': cmState,
  '@codemirror/view': cmView,
  '@codemirror/language': language,
  '@codemirror/autocomplete': autocomplete,
  '@codemirror/commands': commands,
  '@lezer/common': lezerCommon,
  '@lezer/highlight': lezerHighlight,
  '@lezer/markdown': lezerMarkdown,
  yjs,
  react,
  'react-dom': reactDom,
  'react-dom/client': reactDomClient,
  'react/jsx-runtime': jsxRuntime,
};

export function exposeSharedModules(): void {
  (globalThis as { pumiceModules?: Record<string, unknown> }).pumiceModules = SHARED_MODULES;
}
