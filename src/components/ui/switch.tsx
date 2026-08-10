"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex size-11 shrink-0 items-center justify-center rounded-full outline-none before:pointer-events-none before:absolute before:h-[1.15rem] before:w-8 before:rounded-full before:border before:border-transparent before:shadow-xs before:transition-colors data-[state=checked]:before:bg-primary data-[state=unchecked]:before:bg-input focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:data-[state=unchecked]:before:bg-input/80 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none absolute left-1.5 block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0"
        }
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
