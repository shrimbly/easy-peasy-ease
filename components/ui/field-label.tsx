import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const fieldLabelClassName =
  "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";

function FieldLabel({
  className,
  ...props
}: React.ComponentProps<typeof Label>) {
  return <Label className={cn(fieldLabelClassName, className)} {...props} />;
}

export { FieldLabel, fieldLabelClassName };
