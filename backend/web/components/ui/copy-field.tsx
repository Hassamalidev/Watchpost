/* A read-only value with a copy button: URLs and secrets the user pastes somewhere else. */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CopyField({ label, value }: { label: string; value: string }) {
  const tc = useTranslations("common");
  const [copied, setCopied] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  /* "Copied" is about this click, not a state the field stays in. */
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex gap-2">
        <Input
          ref={input}
          readOnly
          value={value}
          aria-label={label}
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            /* The clipboard can be refused (no permission, plain http): select it for Ctrl+C then. */
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              input.current?.select();
            }
          }}
        >
          <Copy aria-hidden />
          {copied ? tc("copied") : tc("copy")}
        </Button>
      </div>
    </div>
  );
}
