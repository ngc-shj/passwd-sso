"use client";

export interface PasswordFormRouter {
  push: (href: string) => void;
  refresh: () => void;
  back: () => void;
}
