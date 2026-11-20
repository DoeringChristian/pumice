import type {
  DocumentsApi,
  MetadataIndexApi,
  VaultApi,
  VaultPath,
  WorkspaceApi,
} from '@pumice/api';

/** What the drawing view and renderers need from the app. */
export interface DrawingServices {
  vault: VaultApi;
  documents: DocumentsApi;
  index: MetadataIndexApi;
  workspace: WorkspaceApi;
  openLink(
    target: string,
    sourcePath: VaultPath,
    subpath: string | undefined,
    newTab: boolean,
  ): Promise<void>;
  openExternal(url: string): void;
  /** A free path for an image pasted into the drawing at `source` (default: next to it). */
  attachmentPath?(source: VaultPath, name: string, extension: string): VaultPath;
}
