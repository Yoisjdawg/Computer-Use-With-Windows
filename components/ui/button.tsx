import * as React from "react";

type Variant = "default" | "outline" | "ghost";
type Size = "default" | "sm";

const base =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const variants: Record<Variant, string> = {
  default: "border border-ring bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-input bg-transparent hover:bg-state-hover hover:text-foreground",
  ghost: "hover:bg-state-hover hover:text-foreground",
};
const sizes: Record<Size, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button ref={ref} className={[base, variants[variant], sizes[size], className].filter(Boolean).join(" ")} {...props} />
  ),
);
Button.displayName = "Button";
