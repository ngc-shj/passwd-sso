"use client";

import { type ComponentProps, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface VisibilityToggleInputProps {
  show: boolean;
  onToggle: () => void;
  inputProps: ComponentProps<typeof Input>;
}

interface TwoColumnFieldsProps {
  left: ReactNode;
  right: ReactNode;
}

interface NotesFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
}

export function VisibilityToggleInput({
  show,
  onToggle,
  inputProps,
}: VisibilityToggleInputProps) {
  return (
    <div className="relative">
      <Input
        {...inputProps}
        type={show ? "text" : "password"}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
        onClick={onToggle}
      >
        {show ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

export function TwoColumnFields({ left, right }: TwoColumnFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">{left}</div>
      <div className="space-y-2">{right}</div>
    </div>
  );
}

export function NotesField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: NotesFieldProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
      />
    </div>
  );
}
