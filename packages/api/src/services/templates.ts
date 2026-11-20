import type { VaultPath } from '@pumice/platform';
import { defineService } from '../service';

export interface TemplateVariables {
  /** Title of the note the template is applied to. */
  title?: string;
  /** Point in time for {{date}} / {{time}} (default: now). */
  date?: Date;
}

export interface TemplatesApi {
  /** Template files in the templates folder. */
  list(): VaultPath[];
  /**
   * Renders a template: `{{title}}`, `{{date}}`, `{{time}}`, `{{date:YYYY-MM-DD}}`,
   * `{{time:HH:mm}}`. A template's `id` property is removed (each note gets its own).
   */
  render(templatePath: VaultPath, vars?: TemplateVariables): Promise<string>;
  /** Creates a note from a template (with a fresh ID) and returns its path. */
  createNote(
    templatePath: VaultPath,
    path: VaultPath,
    vars?: TemplateVariables,
  ): Promise<VaultPath>;
}

export const Templates = defineService<TemplatesApi>('core.templates');
