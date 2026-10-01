/*
 * Long-form pages (docs, legal) are structured text in English, not message-catalog entries: they are
 * documents, reviewed and translated as a whole.
 */
export interface ContentSection {
  heading: string;
  paragraphs?: string[];
  list?: string[];
  /* A command or snippet shown in a code block. */
  code?: string;
}

export interface ContentPage {
  slug: string;
  title: string;
  summary: string;
  sections: ContentSection[];
}
