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
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          <Copy aria-hidden />
          {copied ? tc("copied") : tc("copy")}
        </Button>
      </div>
    </div>
  );
}
