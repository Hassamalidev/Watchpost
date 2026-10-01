/* Renders a docs or legal page from structured content. */
import type * as React from "react";
import type { ContentPage } from "@/features/marketing/content/types";

export function ContentArticle({
  page,
  before,
  after,
}: {
  page: ContentPage;
  before?: React.ReactNode;
  after?: React.ReactNode;
}) {
  return (
    <article className="mx-auto grid max-w-3xl gap-8 px-4 py-12 sm:px-6">
      {before}
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
        <p className="text-muted-foreground">{page.summary}</p>
      </header>
      {page.sections.map((section) => (
        <section key={section.heading} className="grid gap-3">
          <h2 className="text-lg font-semibold">{section.heading}</h2>
          {section.paragraphs?.map((paragraph) => (
            <p key={paragraph} className="text-pretty">
              {paragraph}
            </p>
          ))}
          {section.list && (
            <ul className="grid list-disc gap-1.5 pl-5">
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {section.code && (
            <pre
              tabIndex={0}
              className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs"
            >
              <code>{section.code}</code>
            </pre>
          )}
        </section>
      ))}
      {after}
    </article>
  );
}
