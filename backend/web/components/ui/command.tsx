/* shadcn/ui Command (cmdk inside a Radix dialog), restyled with our tokens. */
"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog } from "radix-ui";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export function CommandDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[20%] left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <CommandPrimitive label={title} className="flex flex-col">
            {children}
          </CommandPrimitive>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CommandInput(props: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b px-3">
      <Search aria-hidden className="size-4 text-muted-foreground" />
      <CommandPrimitive.Input
        className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        {...props}
      />
    </div>
  );
}

export function CommandList(props: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className="max-h-80 overflow-y-auto p-1" {...props} />;
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground" {...props} />
  );
}

export function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}
